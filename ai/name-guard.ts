import { openRouter } from "./openrouter.ts";

export type ProfileNames = {
  realName?: string | undefined;
  displayName?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
};

// proper nouns a report may mention that are not a person's name
const SAFE_TERMS = new Set([
  "slack",
  "hack club",
  "hackclub",
  "github",
  "twitter",
  "youtube",
  "google",
  "openai",
  "linkedin",
  "last.fm",
  "lastfm",
  "cursor",
  "openrouter",
  "grok",
  "gemini",
]);

export function allowedNameWords(names: ProfileNames): Set<string> {
  const allowed = new Set<string>();
  for (const value of Object.values(names)) {
    if (!value) continue;
    const lower = value.toLowerCase().trim();
    if (!lower) continue;
    allowed.add(lower);
    for (const word of lower.split(/[^a-z]+/)) {
      if (word.length >= 2) allowed.add(word);
    }
  }
  return allowed;
}

const SENTENCE_END = new Set([".", "!", "?", "\n", ":", ";"]);

// Flags capitalized words or two-word phrases that are not the target's
// current names. Callers must treat the hits as sensitive: check the count,
// never log, store, or post them.
export function findUnexpectedNames(
  text: string,
  allowed: Set<string>,
): string[] {
  const visible = text
    .replace(/<@[UW][A-Z0-9]+>/g, " ")
    .replace(/<[^>|]+\|([^>]+)>/g, "$1")
    .replace(/\]\([^)]+\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`[^`]*`/g, " ");
  const hits = new Set<string>();
  for (const match of visible.matchAll(
    /[A-Z][A-Za-z0-9]{2,}(?:[ \t]+[A-Z][A-Za-z0-9]{2,})?/g,
  )) {
    const phrase = match[0];
    const lower = phrase.toLowerCase();
    if (SAFE_TERMS.has(lower)) continue;
    const words = lower.split(/[ \t]+/);
    // ids and version strings are not names
    if (words.some((word) => /[0-9]/.test(word))) continue;
    if (words.every((word) => allowed.has(word))) continue;
    const previous = visible
      .slice(0, match.index)
      .trimEnd()
      .slice(-1);
    const sentenceInitial = previous === "" || SENTENCE_END.has(previous);
    // a lone capitalized word at the start of a sentence is usually just
    // capitalization; a name mid-sentence or two capitalized words in a row
    // is not
    if (sentenceInitial && words.length === 1) continue;
    hits.add(phrase);
  }
  return [...hits];
}

const redactPrompt = `You redact personal names from a slack bot's report before it is posted in a public channel. You receive the report and a list of names that are allowed to appear (the subject's current names). Rewrite the report so no other person's name appears anywhere, including any former name of the subject: refer to the subject as "you" and to anyone else as "someone". Keep the tone, the structure, the markdown links, and every non-name detail unchanged. Output only the rewritten report.`;

// Returns the rewritten report, or null when the redactor is unavailable.
// null must be treated as "do not post" - the unredacted text is never safe.
export async function redactPersonalNames(
  report: string,
  allowed: Set<string>,
): Promise<string | null> {
  try {
    const response = await openRouter.chat.send({
      chatRequest: {
        model: "google/gemini-3.5-flash-lite",
        stream: false,
        messages: [
          {
            role: "system",
            content: `${redactPrompt}\n\nAllowed names: ${[...allowed].join(", ") || "(none)"}`,
          },
          { role: "user", content: report },
        ],
      },
    });
    if (!("choices" in response)) return null;
    return response.choices[0]?.message.content?.toString() ?? null;
  } catch {
    return null;
  }
}
