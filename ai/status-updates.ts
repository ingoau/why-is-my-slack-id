import { openRouter } from "./openrouter.ts";
import { statusUpdateParser as statusUpdateParserPrompt } from "./prompts.ts";

export default async function parseStatusUpdate(message: string) {
  try {
    const response = await openRouter.chat.send({
      chatRequest: {
        model: "google/gemini-3.5-flash-lite",
        stream: false,
        messages: [
          {
            role: "system",
            content: statusUpdateParserPrompt,
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
