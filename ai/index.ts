import { Codex } from "@openai/codex-sdk";
import { prompt } from "./prompt";

const codex = new Codex();

export async function processSlackId() {
  const thread = codex.startThread({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
  });

  const turn = await thread.run(prompt + "\nU0923H02Y3B");

  return turn.finalResponse;
}
