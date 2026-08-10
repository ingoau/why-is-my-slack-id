import { App } from "slack.ts";
import { env } from "./env";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: { type: "socket", appToken: process.env.SLACK_APP_TOKEN! },
});

app.on("message", async (message) => {
  if (message.thread_ts || (await message.author)?.is_bot) return;
  if (message.channel.id !== env.CHANNEL_ID) return;

  await message.reply("test");
});

await app.start();
