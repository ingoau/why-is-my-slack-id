import { App } from "@slack/bolt";
import { env } from "./env.ts";
// import { processSlackId } from "./ai.ts";

const app = new App({
  socketMode: true,
  appToken: env.SLACK_APP_TOKEN,
  token: env.SLACK_BOT_TOKEN,
});

app.message(async ({ event, say }) => {
  if ("subtype" in event && event.subtype !== undefined) return;
  if (event.thread_ts || event.bot_id) return;
  if (event.channel !== env.CHANNEL_ID) return;
  say({
    text: "Kevin",
    thread_ts: event.ts,
  });
});

// const app = new App({
//   token: process.env.SLACK_BOT_TOKEN,
//   receiver: { type: "socket", appToken: process.env.SLACK_APP_TOKEN! },
// });

// app.on("message", async (message) => {
//   if (message.thread_ts || (await message.author)?.is_bot) return;
//   if (message.channel.id !== env.CHANNEL_ID) return;

//   if (!message.author?.id) return;
//   const explanation = await processSlackId(message.author?.id);

//   await message.reply(explanation.finalResponse);
// });

await app.start();
