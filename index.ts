import { App } from "@slack/bolt";
import { env } from "./env.ts";
import { processSlackId } from "./ai/index.ts";

const app = new App({
  socketMode: true,
  appToken: env.SLACK_APP_TOKEN,
  token: env.SLACK_BOT_TOKEN,
});

app.message(async ({ event, say, client }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;

  const updateStatus = (status: string) =>
    client.assistant.threads.setStatus({
      thread_ts: event.ts,
      channel_id: event.channel,
      status: "is finding the meaning of your slack id...",
      loading_messages: [status],
    });

  updateStatus("finding the meaning of your slack id...");

  const { events } = await processSlackId(event.user);

  for await (const event of events) {
    switch (event.type) {
      case "item.completed":
        if (event.item.type === "agent_message") {
          updateStatus(event.item.text.substring(0, 50));
        }
        break;
    }
  }
});

await app.start();
