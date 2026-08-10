import { Codex } from "@openai/codex-sdk";
import { prompt } from "./prompt";

const codex = new Codex();

export function processSlackId(slackId: string) {
  const thread = codex.startThread({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
  });

  return thread.run(prompt + "\n" + slackId);
}
