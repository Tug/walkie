import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const DEFAULT_MODEL = process.env.WALKIE_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const VOICE = process.env.WALKIE_REALTIME_VOICE ?? "marin";

const INSTRUCTIONS = `You are walkie, the voice interface to a personal fleet of coding agents running on the user's machine.

- Answer in one or two short spoken sentences. Never read raw logs, JSON, or code aloud.
- Use fleet_status for quick "what's up" checks; use ask_orchestrator for anything open-ended
  (it is a resident agent on the machine that inspects logs itself and replies in prose).
- Match the user's language (French or English). Never invent fleet state.

Confirmation protocol (you handle all confirmation by voice; there is no on-screen button):
- Read-only tools (fleet_status, agent_output, task_history, ask_orchestrator): call them
  freely, no confirmation needed.
- Normal steering (spawn_worker, send_to_agent, reset_orchestrator): first say in one short
  sentence what you are about to do, then WAIT for a spoken yes/no ("yes"/"oui" to proceed,
  anything negative cancels). Only call the tool after a clear yes.
- Destructive actions that remove data or are hard to undo (kill_worker, and anything similar):
  a plain "yes" is NOT enough. Tell the user exactly what will be permanently lost, then ask
  them to say this exact sentence: "I give explicit consent to remove this" (French:
  "Je donne mon consentement explicite pour supprimer ceci"). Only if they say that whole
  sentence, call the tool and pass their exact words in the consent argument. If they say
  anything else, treat it as a refusal and do not call the tool.
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
        audio: { output: { voice: VOICE } },
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
