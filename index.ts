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

  if (body.user.id !== allowed.requester && body.user.id !== allowed.target) {
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

  await client.chat.delete({ channel, ts });
});

app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;
  if (!event.user) return;
  if (event.text?.trimStart().startsWith("##")) return;

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
    const mentionedUserId = [...(event.text?.matchAll(/<@([UW][A-Z0-9]+)>/g) ?? [])]
      .map((match) => match[1])
      .find((userId) => userId !== botUserId);
    const targetUserId = mentionedUserId ?? event.user;

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
        const deleteValue: DeleteButtonValue = {
          requester: event.user,
          target: targetUserId,
        };
        await say({
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
