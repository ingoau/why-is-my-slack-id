import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
async function loadOptedOutUsers(): Promise<Set<string>> {
  try {
    const values: unknown = JSON.parse(await readFile(env.OPT_OUTS_FILE, "utf8"));
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      throw new Error("opt-out file must contain an array of Slack user IDs");
    }
    return new Set(values);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

async function saveOptedOutUsers(users: Set<string>): Promise<void> {
  await mkdir(dirname(env.OPT_OUTS_FILE), { recursive: true });
  const temporaryFile = `${env.OPT_OUTS_FILE}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify([...users].sort(), null, 2)}\n`);
  await rename(temporaryFile, env.OPT_OUTS_FILE);
}

const optedOutUsers = await loadOptedOutUsers();
type AnalysisRecord = {
  targetUserId: string;
  messageTs: string;
  channel: string;
};

async function loadAnalyses(): Promise<Map<string, AnalysisRecord>> {
  try {
    const values: unknown = JSON.parse(await readFile(env.ANALYSES_FILE, "utf8"));
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw new Error("analyses file must contain an object keyed by thread ts");
    }
    const entries = Object.entries(values as Record<string, AnalysisRecord>);
    for (const [, record] of entries) {
      if (
        typeof record !== "object" || record === null ||
        typeof record.targetUserId !== "string" ||
        typeof record.messageTs !== "string" ||
        typeof record.channel !== "string"
      ) {
        throw new Error("analyses file holds malformed records");
      }
    }
    return new Map(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

async function saveAnalyses(analyses: Map<string, AnalysisRecord>): Promise<void> {
  await mkdir(dirname(env.ANALYSES_FILE), { recursive: true });
  const temporaryFile = `${env.ANALYSES_FILE}.tmp`;
  await writeFile(
    temporaryFile,
    `${JSON.stringify(Object.fromEntries(analyses), null, 2)}\n`,
  );
  await rename(temporaryFile, env.ANALYSES_FILE);
}

const analysesByThread = await loadAnalyses();

// "delete" in a thread removes the bot's analysis when its target has opted out
app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (!event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;
  if (event.text?.trim().toLowerCase() !== "delete") return;

  const analysis = analysesByThread.get(event.thread_ts);
  if (!analysis) return;

  if (!optedOutUsers.has(analysis.targetUserId)) {
    await say({
      markdown_text: `<@${analysis.targetUserId}> hasn't opted out, so this stays up`,
      thread_ts: event.thread_ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  try {
    await client.chat.delete({
      channel: analysis.channel,
      ts: analysis.messageTs,
    });
  } catch (error) {
    console.error(error);
    await say({
      markdown_text: "couldn't delete that - try again in a bit",
      thread_ts: event.thread_ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  analysesByThread.delete(event.thread_ts);
  try {
    await saveAnalyses(analysesByThread);
  } catch (error) {
    // the analysis is already gone from slack; keep the in-memory delete so a
    // repeated "delete" doesn't fail against a message that no longer exists
    console.error(error);
  }
});



function takeDailySlot(
  userId: string,
): { ok: true } | { ok: false; retryAt: number } {
  const now = Date.now();
  const last = lastRequestByUser.get(userId);
  if (last !== undefined && now - last < DAY_MS) {
    return { ok: false, retryAt: last + DAY_MS };
  }
  lastRequestByUser.set(userId, now);
  return { ok: true };
}

app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;
  if (!event.user) return;
  if (event.text?.trimStart().startsWith("##")) return;

  const text = event.text?.trim() ?? "";
  const mentionedUserId = [...text.matchAll(/<@([UW][A-Z0-9]+)>/g)]
    .map((match) => match[1])
    .find((userId) => userId !== botUserId);

  const optCommand = /^opt[- ]?(in|out)\b/i.exec(text);
  if (optCommand) {
    const direction = optCommand[1]?.toLowerCase();
    if (direction !== "in" && direction !== "out") return;
    const optingOut = direction === "out";
    const optTargetId = mentionedUserId ?? event.user;

    // anyone can opt a bot out (bots can't consent); people opt themselves out
    if (optTargetId !== event.user) {
      const targetInfo = await client.users.info({ user: optTargetId });
      if (!targetInfo.ok || !targetInfo.user?.is_bot) {
        await say({
          markdown_text: "you can only opt out yourself or a bot",
          thread_ts: event.ts,
          unfurl_links: false,
          unfurl_media: false,
        });
        return;
      }
    }

    if (optingOut) {
      optedOutUsers.add(optTargetId);
    } else {
      optedOutUsers.delete(optTargetId);
    }
    try {
      await saveOptedOutUsers(optedOutUsers);
    } catch (error) {
      if (optingOut) {
        optedOutUsers.delete(optTargetId);
      } else {
        optedOutUsers.add(optTargetId);
      }
      console.error(error);
      await say({
        markdown_text: "couldn't save that opt-out change - nothing changed",
        thread_ts: event.ts,
        unfurl_links: false,
        unfurl_media: false,
      });
      return;
    }

    let confirmation: string;
    if (optTargetId === event.user) {
      confirmation = optingOut
        ? "you're opted out - nobody can run this on you anymore. send `opt in` to undo"
        : "you're back in - send `opt out` anytime to leave again";
    } else {
      confirmation = optingOut
        ? `<@${optTargetId}> is opted out - send \`opt in <@${optTargetId}>\` to undo`
        : `<@${optTargetId}> is back in`;
    }
    await say({
      markdown_text: confirmation,
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  const targetUserId = mentionedUserId ?? event.user;
  if (optedOutUsers.has(targetUserId)) {
    await say({
      markdown_text:
        targetUserId === event.user
          ? "you've opted out of this - send `opt in` if you want back in"
          : `<@${targetUserId}> has opted out of this, so their slack id stays a mystery`,
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }

  const rateLimit = takeDailySlot(event.user);
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

  try {
    const profileInfo = await client.users.profile.get({ user: targetUserId });
    if (
      !profileInfo.ok ||
      profileInfo.profile === undefined ||
      profileInfo.profile.fields === undefined
    )
      return;

    const profileFields = Object.entries(profileInfo.profile?.fields).map(
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

    for await (const agentEvent of processSlackId(targetUserId, profileFields)) {
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
        const posted = await say({
          markdown_text: message,
          thread_ts: event.ts,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (posted.ts !== undefined) {
          analysesByThread.set(event.ts, {
            targetUserId,
            messageTs: posted.ts,
            channel: event.channel,
          });
          try {
            await saveAnalyses(analysesByThread);
          } catch (error) {
            // losing the record only means a later "delete" is ignored
            console.error(error);
          }
        }
      }
    }

    if (!completed) {
      throw new Error("agent stream ended without finishing");
    }
  } catch (error) {
    console.error(error);
    await say({
      markdown_text: "something went wrong cc <@U0923H02Y3B>",
      thread_ts: event.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    return;
  }
});

await app.start();
