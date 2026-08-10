import { App } from "slack.ts";
import { env } from "./env";
import { processSlackId } from "./ai";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: { type: "socket", appToken: process.env.SLACK_APP_TOKEN! },
});

app.on("message", async (message) => {
  if (message.thread_ts || (await message.author)?.is_bot) return;
  if (message.channel.id !== env.CHANNEL_ID) return;

  if (!message.author?.id) return;
  const explanation = await processSlackId(message.author?.id);

  await message.reply(explanation.finalResponse);
});

await app.start();
