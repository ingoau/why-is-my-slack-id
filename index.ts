import { App } from "@slack/bolt";
import { env } from "./env.ts";
import { processSlackId } from "./ai/index.ts";
import parseStatusUpdate from "./ai/status-updates.ts";

const app = new App({
  socketMode: true,
  appToken: env.SLACK_APP_TOKEN,
  token: env.SLACK_BOT_TOKEN,
});

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

app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;

  const profileInfo = await client.users.profile.get({ user: event.user });
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

  const { events } = await processSlackId(event.user, profileFields);

  let message = "";
  let completed = false;

  for await (const agentEvent of events) {
    console.log(agentEvent.type);
    switch (agentEvent.type) {
      case "item.completed":
        if (agentEvent.item.type === "agent_message") {
          message = agentEvent.item.text;
          setTimeout(async () => {
            if (!completed) {
              const parsed = await parseStatusUpdate(message);
              // Check again
              if (!completed) updateStatus(parsed);
            }
          }, 100);
        }
        break;
    }
    switch (agentEvent.type) {
      case "turn.completed":
        completed = true;
        await say({
          markdown_text: message,
          thread_ts: event.ts,
          unfurl_links: false,
          unfurl_media: false,
        });
        return;
    }
  }
});

await app.start();
