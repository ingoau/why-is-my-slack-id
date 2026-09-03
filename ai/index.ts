import { Agent } from "@cursor/sdk";
import { agent as agentPrompt } from "./prompts.ts";
import { slackSearchTool } from "./slack.ts";
import { env } from "../env.ts";

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
    apiKey: env.CURSOR_API_KEY,
    model: { id: "grok-4.5" },
    local: {
      cwd: process.cwd(),
      customTools: {
        random_number: {
          description: "Generate a random number between 0 and 1",
          async execute() {
            return Math.random();
          },
        },
        slack_search_messages: slackSearchTool,
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
          .map(
            (f) =>
              `<field><name>${f.name}</name><value>${f.value}</value><alt>${f.alt || ""}</alt></field>`,
          )
          .join(""),
    )
  ).stream();
}
