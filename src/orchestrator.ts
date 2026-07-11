import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".fleet-orchestrator");
const SESSION_FILE = join(STATE_DIR, "session.json");

const SYSTEM_PROMPT = `You are the resident orchestrator of a personal multi-agent fleet running on this machine via multiclaude (tmux + git worktrees, one Claude Code instance per agent, PRs gated by CI).

Your job when asked a question:
- Inspect the fleet yourself: \`multiclaude status\`, \`multiclaude history <repo>\`, \`tmux capture-pane -p -t mc-<repo>:<agent> -S -200\`, \`gh pr list\`, and ~/.multiclaude/state.json.
- Answer as a chief of staff: short, factual, decision-oriented. Lead with what matters (blocked agents, failing CI, PRs awaiting approval), not raw logs.
- You may steer agents when explicitly asked: spawn workers (\`multiclaude worker create "task" --repo <repo>\`), or send a message into an agent's tmux window (tmux send-keys the literal text with -l, then Enter, as two separate calls).
- You operate under a command allowlist: only fleet inspection and steering commands are permitted. Do not attempt anything else (no merges, no pushes, no file edits, no deletions).
- Your answers may be read aloud by a voice interface: prefer 2-5 sentences of plain prose, no markdown tables, no code blocks unless asked. Never use em dashes; use commas, colons, or separate sentences.`;

// Only these command shapes may run. Everything else is denied.
const ALLOWED_COMMANDS: RegExp[] = [
  /^multiclaude (status|list|history|logs|diagnostics)\b/,
  /^multiclaude (agents|worker|work) list\b/,
  /^multiclaude worker create /,
  /^multiclaude (agent|message) (list-messages|read-message|list|read)\b/,
  /^tmux (list-sessions|list-windows|capture-pane)\b/,
  /^tmux send-keys /,
  /^gh pr (list|view|checks|status)\b/,
  /^gh run (list|view)\b/,
  /^(cat|head|tail|ls|grep|jq) /,
];

function commandAllowed(cmd: string): boolean {
  const trimmed = cmd.trim();
  // Reject shell chaining/subshells so the allowlist can't be smuggled past.
  if (/[;&|`$(]/.test(trimmed.replace(/"[^"]*"|'[^']*'/g, ""))) return false;
  return ALLOWED_COMMANDS.some((re) => re.test(trimmed));
}

let sessionId: string | undefined;
let queue: Promise<unknown> = Promise.resolve();

async function loadSession(): Promise<void> {
  try {
    sessionId = JSON.parse(await readFile(SESSION_FILE, "utf8")).sessionId;
  } catch {
    sessionId = undefined;
  }
}

async function saveSession(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify({ sessionId, savedAt: new Date().toISOString() }));
}

async function runQuery(question: string): Promise<string> {
  await loadSession();
  let answer = "";
  const q = query({
    prompt: question,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
      resume: sessionId,
      cwd: join(homedir(), ".multiclaude"),
      allowedTools: ["Bash", "Read", "Grep", "Glob"],
      canUseTool: async (toolName, input) => {
        if (toolName === "Bash") {
          const cmd = String((input as { command?: string }).command ?? "");
          return commandAllowed(cmd)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: `Command not in fleet allowlist: ${cmd}` };
        }
        // Read/Grep/Glob are read-only: allow.
        return { behavior: "allow", updatedInput: input };
      },
      maxTurns: 30,
    },
  });
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
    } else if (msg.type === "result") {
      answer = msg.subtype === "success" ? msg.result : `Orchestrator error: ${msg.subtype}`;
    }
  }
  await saveSession();
  return answer || "(no answer)";
}

/** Ask the resident orchestrator. Calls are serialized: one brain, one thread of thought. */
export function ask(question: string): Promise<string> {
  const next = queue.then(() => runQuery(question));
  queue = next.catch(() => {});
  return next;
}

/** Drop the persisted session so the next ask starts a fresh conversation. */
export async function resetSession(): Promise<string> {
  sessionId = undefined;
  await saveSession();
  return "Orchestrator session reset.";
}
