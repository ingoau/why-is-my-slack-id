import { Codex } from "@openai/codex-sdk";
import { prompt } from "./prompt";

const codex = new Codex();

export function processSlackId() {
  const thread = codex.startThread({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
  });

  return thread.runStreamed(prompt + "\nU0923H02Y3B");
}
