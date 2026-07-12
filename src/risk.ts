// Tool risk classification and spoken-consent enforcement for hands-free use.
//
// - "normal" tools (spawn a worker, message an agent): the voice agent confirms
//   intent and proceeds on a spoken yes/no. No server gate; these are non-destructive.
// - "dangerous" tools (anything that removes data or is hard to undo): the server
//   REQUIRES a `consent` argument equal to an explicit phrase. The voice agent must
//   ask the user to say that exact sentence and pass it verbatim. This gate is
//   model-mediated (the model fills the argument), so every call is also logged.

export type Risk = "normal" | "dangerous";

export const DANGEROUS_TOOLS = new Set(["kill_worker"]);

export function riskOf(tool: string): Risk {
  return DANGEROUS_TOOLS.has(tool) ? "dangerous" : "normal";
}

// Accept the canonical English phrase or its French equivalent (Tug works in both).
const CONSENT_PHRASES = [
  "i give explicit consent to remove this",
  "je donne mon consentement explicite pour supprimer ceci",
];

export const CONSENT_PROMPT_EN = "I give explicit consent to remove this";

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
}

export function consentValid(consent: string | undefined | null): boolean {
  if (!consent) return false;
  const n = normalize(consent);
  return CONSENT_PHRASES.includes(n);
}
