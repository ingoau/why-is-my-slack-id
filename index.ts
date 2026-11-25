import { App } from "@slack/bolt";
import { env } from "./env.ts";
import { processSlackId } from "./ai/index.ts";
import parseStatusUpdate from "./ai/status-updates.ts";

const app = new App({
  socketMode: true,
  appToken: env.SLACK_APP_TOKEN,
  token: env.SLACK_BOT_TOKEN,
});

const auth = await app.client.auth.test();
if (!auth.ok || !auth.user_id) throw new Error(auth.error);
const botUserId = auth.user_id;

const teamProfile = await app.client.team.profile.get();
if (
  !teamProfile.ok ||
  teamProfile.profile === undefined ||
  teamProfile.profile.fields === undefined
)
  throw new Error(teamProfile.error);

const teamFields = Object.fromEntries(
  teamProfile.profile.fields.map((field) => [field.id, field.label]),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const lastRequestByUser = new Map<string, number>();
// Users with a run in progress. Guards against concurrent messages skipping
// the daily limit while the slot hasn't been committed yet.
const inFlightUsers = new Set<string>();

type SlotResult =
  | { ok: true }
  | { ok: false; reason: "daily"; retryAt: number }
  | { ok: false; reason: "in_flight" };

// Reserve a run for this user. The slot only counts towards the daily limit
// once `commitDailySlot` is called (after the reply is posted); otherwise
// `releaseDailySlot` frees it again.
function reserveDailySlot(userId: string): SlotResult {
  // Both checks below only enforce the daily limit. With it disabled, users
  // can run as many analyses as they like, including several at once.
  if (env.DISABLE_RATE_LIMIT) return { ok: true };
  if (inFlightUsers.has(userId)) return { ok: false, reason: "in_flight" };
  const last = lastRequestByUser.get(userId);
  if (last !== undefined && Date.now() - last < DAY_MS) {
    return { ok: false, reason: "daily", retryAt: last + DAY_MS };
  }
  inFlightUsers.add(userId);
  return { ok: true };
}

function commitDailySlot(userId: string) {
  lastRequestByUser.set(userId, Date.now());
}

function releaseDailySlot(userId: string) {
  inFlightUsers.delete(userId);
}

// Normal runs take ~1.5–3 min.
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

class RunTimeoutError extends Error {
  constructor() {
    super(`agent run timed out after ${RUN_TIMEOUT_MS / 1000}s`);
  }
}

class RequestDeletedError extends Error {
  constructor() {
    super("request message was deleted");
  }
}

// Runs in progress, keyed by the request message, so deleting the request
// can cancel its run.
const runsByMessage = new Map<string, AbortController>();
const messageKey = (channel: string, ts: string) => `${channel}:${ts}`;

// At most MAX_CONCURRENT_RUNS analyses run at once across everyone; the rest
// wait in a FIFO queue. Every run shares one Slack search token, so running
// too many at once just makes them all time out.
let activeRuns = 0;
const runWaiters: Array<() => void> = [];

type RunSlot = {
  // 0 if the run can start now, otherwise its place in the queue.
  position: number;
  // Resolves once the run may start; rejects with the reason if `signal`
  // aborts first.
  ready: Promise<void>;
  // Frees the slot, or leaves the queue. Safe to call more than once.
  release: () => void;
};

function acquireRunSlot(signal: AbortSignal): RunSlot {
  let state: "waiting" | "active" | "released" = "waiting";
  let grant!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    grant = () => {
      state = "active";
      activeRuns++;
      resolve();
    };
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  ready.catch(() => {});

  const release = () => {
    if (state === "active") {
      activeRuns--;
      startQueuedRuns();
    } else if (state === "waiting") {
      const i = runWaiters.indexOf(grant);
      if (i !== -1) runWaiters.splice(i, 1);
    }
    state = "released";
  };

  if (activeRuns < env.MAX_CONCURRENT_RUNS && runWaiters.length === 0) {
    grant();
    return { position: 0, ready, release };
  }
  runWaiters.push(grant);
  return { position: runWaiters.length, ready, release };
}

function startQueuedRuns() {
  while (activeRuns < env.MAX_CONCURRENT_RUNS && runWaiters.length > 0) {
    runWaiters.shift()!();
  }
}

// Iterate `source`, failing with `signal.reason` if it isn't finished when
// `signal` aborts, even if the underlying iterator is stuck.
async function* untilAborted<T>(
  source: AsyncGenerator<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      const next = await Promise.race([source.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Don't await: if the source is hung, return() may never settle.
    source.return(undefined).catch(() => {});
  }
}

const DELETE_ACTION_ID = "delete_analysis";

type DeleteButtonValue = { requester: string; target: string };

// Only the person who asked for the analysis, or the person it's about, can
// delete it.
app.action(DELETE_ACTION_ID, async ({ ack, body, action, client }) => {
  await ack();
  if (body.type !== "block_actions" || action.type !== "button") return;

  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts) return;

  let allowed: DeleteButtonValue;
  try {
    allowed = JSON.parse(action.value ?? "");
  } catch {
    return;
  }

  const logContext = {
    deletedBy: body.user.id,
    requester: allowed.requester,
    target: allowed.target,
    channel,
    ts,
  };

  if (body.user.id !== allowed.requester && body.user.id !== allowed.target) {
    console.log("refused analysis delete", logContext);
    const who =
      allowed.requester === allowed.target
        ? `<@${allowed.requester}>`
        : `<@${allowed.requester}> or <@${allowed.target}>`;
    await client.chat.postEphemeral({
      channel,
      user: body.user.id,
      thread_ts: body.message?.thread_ts,
      text: `only ${who} can delete this`,
    });
    return;
  }

  console.log("deleting analysis", logContext);
  await client.chat.delete({ channel, ts });
});

// If the request message is deleted mid-run, stop: replying to a deleted
// thread parent would post into the main channel instead.
app.event("message", async ({ event }) => {
  let deletedTs: string | undefined;
  if (event.subtype === "message_deleted") {
    deletedTs = event.deleted_ts;
  } else if (
    event.subtype === "message_changed" &&
    (event.message as { subtype?: string }).subtype === "tombstone"
  ) {
    // A deleted parent that already has replies becomes a tombstone.
    deletedTs = event.message.ts;
  }
  if (!deletedTs) return;

  const run = runsByMessage.get(messageKey(event.channel, deletedTs));
  if (!run || run.signal.aborted) return;
  console.log("request deleted, cancelling run", {
    channel: event.channel,
    ts: deletedTs,
  });
  run.abort(new RequestDeletedError());
});

app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;
  if (!event.user) return;
  if (event.text?.trimStart().startsWith("##")) return;

  const user = event.user;
  const rateLimit = reserveDailySlot(user);
  if (!rateLimit.ok && rateLimit.reason === "in_flight") {
    await say({
      markdown_text: "you already have one running, hang tight",
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }
  if (!rateLimit.ok) {
    const hoursLeft = Math.max(
      1,
      Math.ceil((rateLimit.retryAt - Date.now()) / (60 * 60 * 1000)),
    );
    await say({
      markdown_text: `you can only run this once per day. come back in ~${hoursLeft}h`,
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  // Aborted when the run times out or the request message is deleted.
  const runControl = new AbortController();
  const runKey = messageKey(event.channel, event.ts);
  runsByMessage.set(runKey, runControl);
  let slot: RunSlot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const mentionedUserId = [...(event.text?.matchAll(/<@([UW][A-Z0-9]+)>/g) ?? [])]
      .map((match) => match[1])
      .find((userId) => userId !== botUserId);
    const targetUserId = mentionedUserId ?? event.user;

    let profileInfo;
    try {
      profileInfo = await client.users.profile.get({ user: targetUserId });
    } catch (error) {
      profileInfo = {
        ok: false,
        error: (error as { data?: { error?: string } }).data?.error ?? String(error),
        profile: undefined,
      };
    }
    if (runControl.signal.aborted) throw runControl.signal.reason;
    if (!profileInfo.ok || profileInfo.profile === undefined) {
      console.error("profile lookup failed", {
        targetUserId,
        error: profileInfo.error,
      });
      await say({
        markdown_text:
          profileInfo.error === "user_not_found"
            ? `couldn't find <@${targetUserId}>. is that a real user?`
            : `couldn't look up <@${targetUserId}>'s profile (${profileInfo.error ?? "unknown error"})`,
        thread_ts: event.ts,
        unfurl_links: false,
        unfurl_media: false,
      });
      return;
    }

    // Users who never filled in custom fields have none; the agent can still
    // search Slack and the web.
    const profileFields = Object.entries(profileInfo.profile.fields ?? {}).map(
      ([id, field]) => ({
        ...field,
        name: teamFields[id],
      }),
    );

    slot = acquireRunSlot(runControl.signal);
    if (slot.position > 0) {
      console.log("run queued", { requester: user, position: slot.position });
      await say({
        markdown_text: `you're #${slot.position} in the queue, hang tight`,
        thread_ts: event.ts,
        unfurl_links: false,
        unfurl_media: false,
      });
    }
    await slot.ready;
    // The timeout covers the run itself, not time spent in the queue.
    timer = setTimeout(
      () => runControl.abort(new RunTimeoutError()),
      RUN_TIMEOUT_MS,
    );

    const updateStatus = (status: string | undefined) =>
      client.assistant.threads.setStatus({
        thread_ts: event.ts,
        channel_id: event.channel,
        status: "is finding the meaning of your slack id...",
        loading_messages: [status || "finding the meaning of your slack id..."],
      }).catch((error) => console.error("failed to set status", error));

    updateStatus("finding the meaning of your slack id...");

    let message = "";
    let thinking = "";
    let completed = false;
    let lastFlush = 0;
    const THROTTLE_MS = 2000;

    const maybeUpdateStatus = () => {
      if (completed) return;
      const now = Date.now();
      if (now - lastFlush < THROTTLE_MS) return;
      // Prefer the answer-in-progress; fall back to recent reasoning so the
      // status stays live during the long thinking phase early in the turn.
      const context = message || thinking.slice(-1500);
      if (!context) return;
      lastFlush = now;
      parseStatusUpdate(context)
        .then((parsed) => {
          if (!completed && !runControl.signal.aborted) updateStatus(parsed);
        })
        .catch(() => {});
    };

    for await (const agentEvent of untilAborted(
      processSlackId(targetUserId, profileFields, runControl.signal),
      runControl.signal,
    )) {
      if (completed) continue;

      if (agentEvent.type === "thinking" && agentEvent.text) {
        if (message) message = "";
        thinking += agentEvent.text;
        maybeUpdateStatus();
      }

      if (agentEvent.type === "assistant" && agentEvent.message?.content) {
        for (const part of agentEvent.message.content) {
          if (part.type === "text") message += part.text;
        }
        maybeUpdateStatus();
      }

      if (agentEvent.type === "status" && agentEvent.status === "FINISHED") {
        if (runControl.signal.aborted) throw runControl.signal.reason;
        completed = true;
        const deleteValue: DeleteButtonValue = {
          requester: user,
          target: targetUserId,
        };
        const posted = await say({
          text: message,
          blocks: [
            { type: "markdown", text: message },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: DELETE_ACTION_ID,
                  text: { type: "plain_text", text: "Delete" },
                  style: "danger",
                  value: JSON.stringify(deleteValue),
                  confirm: {
                    title: { type: "plain_text", text: "Delete this message?" },
                    text: {
                      type: "plain_text",
                      text: "This will permanently remove the analysis.",
                    },
                    confirm: { type: "plain_text", text: "Delete" },
                    deny: { type: "plain_text", text: "Cancel" },
                    style: "danger",
                  },
                },
              ],
            },
          ],
          thread_ts: event.ts,
          unfurl_links: false,
          unfurl_media: false,
        });
        commitDailySlot(user);
        // The reply is out; don't report a timeout while the run tears down.
        clearTimeout(timer);
        console.log("posted analysis", {
          requester: user,
          target: targetUserId,
          channel: event.channel,
          ts: posted.ts,
        });
      }
    }

    if (!completed) {
      if (runControl.signal.aborted) throw runControl.signal.reason;
      throw new Error("agent stream ended without finishing");
    }
  } catch (error) {
    // Any reply would land in the main channel now that the parent is gone.
    if (runControl.signal.reason instanceof RequestDeletedError) {
      console.log("analysis cancelled, request deleted", { requester: user });
      return;
    }
    console.error("analysis failed", {
      requester: user,
      timedOut: error instanceof RunTimeoutError,
      error,
    });
    await say({
      markdown_text: "something went wrong cc <@U0923H02Y3B>",
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  } finally {
    clearTimeout(timer);
    slot?.release();
    runsByMessage.delete(runKey);
    releaseDailySlot(user);
  }
});

await app.start();
