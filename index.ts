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

// Iterate `source`, failing with RunTimeoutError if it isn't finished when
// `signal` aborts, even if the underlying iterator is stuck.
async function* untilAborted<T>(
  source: AsyncGenerator<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new RunTimeoutError());
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

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), RUN_TIMEOUT_MS);

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

    const updateStatus = (status: string | undefined) =>
      client.assistant.threads.setStatus({
        thread_ts: event.ts,
        channel_id: event.channel,
        status: "is finding the meaning of your slack id...",
        loading_messages: [status || "finding the meaning of your slack id..."],
      });

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
          if (!completed) updateStatus(parsed);
        })
        .catch(() => {});
    };

    for await (const agentEvent of untilAborted(
      processSlackId(targetUserId, profileFields, timeout.signal),
      timeout.signal,
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
        console.log("posted analysis", {
          requester: user,
          target: targetUserId,
          channel: event.channel,
          ts: posted.ts,
        });
      }
    }

    if (!completed) {
      throw new Error("agent stream ended without finishing");
    }
  } catch (error) {
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
    releaseDailySlot(user);
  }
});

await app.start();
