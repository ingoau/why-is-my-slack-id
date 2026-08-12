import { openRouter } from "./openrouter";

export default async function parseStatusUpdate(message: string) {
  try {
    const response = await openRouter.chat.send({
      chatRequest: {
        model: "openai/gpt-5.6-luna",
        provider: { sort: "latency" },
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You will take in a message from an AI agent and convert it to be more concise, so it can be shown to the user. YOU MUST ALWAYS output a response under 50 characters. You can remove context if it's needed to make the response shorter.",
          },
          {
            role: "user",
            content: message,
          },
        ],
      },
    });

    // fucking openrouter being broken
    if (!("choices" in response)) throw new Error("Unexpected stream");

    return response.choices[0]?.message.content
      ?.toString()
      .trim()
      .substring(0, 50);
  } catch {
    return message.substring(0, 50);
  }
}
