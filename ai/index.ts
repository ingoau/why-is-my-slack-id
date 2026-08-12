import { Codex } from "@openai/codex-sdk";
import { agent as agentPrompt } from "./prompts.ts";

const codex = new Codex();

export function processSlackId(
  slackId: string,
  fields: {
    name: any;
    alt?: string | undefined;
    label?: string | undefined;
    value?: string | undefined;
  }[],
) {
  const thread = codex.startThread({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
  });
  return thread.runStreamed(
    agentPrompt +
      "\n\n" +
      slackId +
      "\n\nInfo about the user:\n" +
      fields
        .map((f) => `${f.name}:\n${f.value}\n${f.alt || ""}\n\n`)
        .join("\n"),
  );
}
