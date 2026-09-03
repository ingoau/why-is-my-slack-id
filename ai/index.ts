import { Agent } from "@cursor/sdk";
import { agent as agentPrompt } from "./prompts.ts";

export async function processSlackId(
  slackId: string,
  fields: {
    name: any;
    alt?: string | undefined;
    label?: string | undefined;
    value?: string | undefined;
  }[],
) {
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: "glm-5.2" },
    local: { cwd: process.cwd() },
    tools: ["webFetch", "webSearch", "mcp"],
  });

  return (
    await agent.send(
      agentPrompt +
        "\n\n" +
        slackId +
        "\n\nInfo about the user:\n" +
        fields
          .map((f) => `${f.name}:\n${f.value}\n${f.alt || ""}\n\n`)
          .join("\n"),
    )
  ).stream();
}
