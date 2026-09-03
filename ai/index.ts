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
    mcpServers: {
      slack: {
        type: "stdio",
        command: "npx",
        args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
        env: { SLACK_MCP_XOXP_TOKEN: process.env.SLACK_USER_TOKEN! },
      },
    },
    local: {
      cwd: process.cwd(),
      customTools: {
        random_number: {
          description: "Generate a random number between 0 and 1",
          async execute() {
            return Math.random();
          },
        },
      },
    },
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
