import { Codex } from "@openai/codex-sdk";
import { agent as agentPrompt } from "./prompts.ts";

const codex = new Codex();

export function processSlackId(slackId: string) {
  const thread = codex.startThread({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
  });

  return thread.runStreamed(agentPrompt + "\n" + slackId);
}
