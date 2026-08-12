import { OpenRouter } from "@openrouter/sdk";
import { env } from "../env.ts";

export const openRouter = new OpenRouter({
  apiKey: env.OPENROUTER_KEY,
});
