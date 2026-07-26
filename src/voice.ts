import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const DEFAULT_MODEL = process.env.WALKIE_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const VOICE = process.env.WALKIE_REALTIME_VOICE ?? "marin";
// Transcribe the user's own speech so it shows in the app and is logged for troubleshooting.
const TRANSCRIBE_MODEL = process.env.WALKIE_REALTIME_TRANSCRIBE ?? "gpt-4o-transcribe";
// Pin the spoken language (Tug speaks French); a fixed language stops the transcriber from
// hallucinating CJK on background noise. Set WALKIE_REALTIME_LANG (ISO-639-1) to change.
const TRANSCRIBE_LANG = process.env.WALKIE_REALTIME_LANG ?? "fr";
const LANG_NAME: Record<string, string> = {
  fr: "French",
  en: "English",
  es: "Spanish",
  de: "German",
  it: "Italian",
};
const SPOKEN_LANGUAGE = LANG_NAME[TRANSCRIBE_LANG] ?? TRANSCRIBE_LANG;

const INSTRUCTIONS = `You ARE walkie: the orchestrator of a personal fleet of coding agents running on the
user's machine, speaking to the user by voice. Talk in the first person as the one who runs the
fleet. Never refer to "the orchestrator" as a third party or say things like "I'll ask the
orchestrator"; the tools are simply how you see and steer your own fleet, so speak as if you did it
yourself ("Let me check", "I've spawned a worker on Tug/walkie", "one worker is stuck on a trust
prompt"). You are the interface; from the user's side there is only you.

- Answer in one or two short spoken sentences. Never read raw logs, JSON, or code aloud.
- Use fleet_status for quick "what's up" checks; use ask_orchestrator for anything open-ended
  (it inspects logs in depth and hands you back prose). Relay its answer as your own words.
- The user speaks ${SPOKEN_LANGUAGE}; speak ${SPOKEN_LANGUAGE} back. Never invent fleet state.

Confirmation protocol (you handle all confirmation by voice; there is no on-screen button):
- Read-only tools (fleet_status, agent_output, task_history, ask_orchestrator): call them
  freely, no confirmation needed.
- Normal steering (spawn_worker, send_to_agent, reset_orchestrator): first say in one short
  sentence what you are about to do, then WAIT for a spoken yes/no ("yes"/"oui" to proceed,
  anything negative cancels). Only call the tool after a clear yes. A plain spoken yes is
  enough here; do NOT ask for the consent sentence for an ordinary spawn or message. When you
  spawn, identify the repo as owner/name (e.g. Tug/walkie); a bare name assumes the user's own
  GitHub account.
- The exact consent SENTENCE is required ONLY for irreversible/elevated actions: kill_worker,
  or a spawn where the user explicitly wants the worker to push main / merge / force-push. In
  those cases a plain "yes" is NOT enough: tell the user exactly what is at stake, then ask
  them to say this whole sentence: "I give explicit consent to remove this" (French: "Je donne
  mon consentement explicite pour supprimer ceci"). Only if they say it, call the tool and pass
  their exact words in the consent argument. Anything else is a refusal.
- If a tool is refused or fails, say so plainly and suggest the next step.`;

export const voiceRouter: Router = Router();

// The page itself contains no secrets: auth happens in-page with the fleet token.
voiceRouter.get("/voice", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "voice.html"));
});

// Mints an ephemeral Realtime client secret so the OpenAI API key never reaches the browser.
// Sits behind the bearer-token middleware like every other endpoint.
voiceRouter.post("/voice/secret", async (_req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on the walkie server" });
  }
  const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: DEFAULT_MODEL,
        instructions: INSTRUCTIONS,
        audio: {
          input: {
            transcription: {
              model: TRANSCRIBE_MODEL,
              // Pinning the language stops the transcriber hallucinating CJK on background noise.
              // No `prompt` here: the transcription prompt was being surfaced verbatim as if the
              // user had spoken it ("Transcribe only the primary speaker;..."), polluting the turn.
              language: TRANSCRIBE_LANG,
            },
          },
          output: { voice: VOICE },
        },
      },
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return res.status(502).json({ error: `OpenAI client_secrets failed (${upstream.status})`, detail });
  }
  const data = (await upstream.json()) as { value: string; expires_at: number };
  res.json({ value: data.value, expires_at: data.expires_at, model: DEFAULT_MODEL });
});
