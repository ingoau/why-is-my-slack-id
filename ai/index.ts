import { Codex } from "@openai/codex-sdk";

const codex = new Codex();

export async function processSlackId() {
  const thread = codex.startThread();

  const turn = await thread.run("");

  return turn.finalResponse;
}
