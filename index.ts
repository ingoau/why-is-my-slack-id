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
  await client.assistant.threads.setStatus({
    thread_ts: event.ts,
    channel_id: event.channel,
    status: "finding the meaning of your slack id...",
    loading_messages: ["finding the meaning of your slack id..."],
  });

  const explanation = await processSlackId(event.user);

  await say({
    text: explanation.finalResponse,
    thread_ts: event.ts,
  });
});

await app.start();
