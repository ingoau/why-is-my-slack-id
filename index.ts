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

  let message = "";

  for await (const agentEvent of events) {
    console.log(agentEvent.type);
    switch (agentEvent.type) {
      case "item.completed":
        if (agentEvent.item.type === "agent_message") {
          message = agentEvent.item.text;
          updateStatus(agentEvent.item.text.substring(0, 50));
        }
        break;
    }
    switch (agentEvent.type) {
      case "turn.completed":
        await say({
          markdown_text: message,
          thread_ts: event.ts,
        });
    }
  }
});

await app.start();
