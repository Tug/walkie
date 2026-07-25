// Session discovery + conversion. Reads a Claude or Codex session, normalizes it, and renders a
// portable, tool-vocabulary-translated handoff transcript for a target agent. (Writing a native
// auto-resume file for the target is the live-validated follow-up; the transcript is what a human
// or the target agent continues from today.)

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeSession } from "./claude.js";
import { parseCodexSession } from "./codex.js";
import { type CanonicalSession, type ConvAgent, renderedToolName } from "./core.js";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const OUT_DIR = join(homedir(), ".fleet-orchestrator", "convert");

async function walkJsonl(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[];
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(p);
  }
  return acc;
}

async function parseByPath(path: string): Promise<CanonicalSession | null> {
  const text = await readFile(path, "utf8");
  if (path.includes(`${join(".codex", "sessions")}`) || /\/rollout-/.test(path))
    return parseCodexSession(path, text);
  return parseClaudeSession(path, text);
}

export interface SessionSummary {
  provider: ConvAgent;
  sessionId: string;
  title: string;
  cwd: string;
  path: string;
  mtime: string;
}

/** Recent Claude + Codex sessions, newest first (subagent transcripts excluded). */
export async function listRecentSessions(limit = 20): Promise<SessionSummary[]> {
  const files = [...(await walkJsonl(CLAUDE_PROJECTS)), ...(await walkJsonl(CODEX_SESSIONS))].filter(
    (p) => !p.includes("/subagents/"),
  );
  const withTime = await Promise.all(
    files.map(async (p) => ({ p, m: (await stat(p).catch(() => null))?.mtimeMs ?? 0 })),
  );
  withTime.sort((a, b) => b.m - a.m);
  const out: SessionSummary[] = [];
  for (const { p, m } of withTime.slice(0, limit)) {
    const s = await parseByPath(p).catch(() => null);
    if (s) {
      out.push({
        provider: s.sourceProvider,
        sessionId: s.sourceSessionID,
        title: s.title,
        cwd: s.cwd,
        path: p,
        mtime: new Date(m).toISOString(),
      });
    }
  }
  return out;
}

async function resolveSession(ref: string): Promise<CanonicalSession | null> {
  if (ref.endsWith(".jsonl")) return parseByPath(ref);
  // Treat ref as a session id: find a matching file across both trees.
  const files = [...(await walkJsonl(CLAUDE_PROJECTS)), ...(await walkJsonl(CODEX_SESSIONS))];
  const hit = files.find((p) => p.includes(ref));
  return hit ? parseByPath(hit) : null;
}

export function renderTranscript(session: CanonicalSession, target: ConvAgent): string {
  const header = [
    `# Continued from a ${session.sourceProvider} session into ${target}`,
    ``,
    `Original title: ${session.title}`,
    `Original cwd: ${session.cwd}`,
    `Original session id: ${session.sourceSessionID}`,
    session.model ? `Original model: ${session.model}` : "",
    ``,
    `Hidden reasoning and provider-private state are not portable. Continue from the visible`,
    `transcript, the tool summaries below (named in ${target}'s vocabulary), and current repo state.`,
    ``,
    `---`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const body = session.events
    .map((e) => {
      if (e.kind === "message" || e.kind === "question" || e.kind === "answer") {
        const who = e.role === "assistant" ? "Assistant" : e.role === "developer" ? "Developer" : "User";
        return `**${who}:** ${e.text}`;
      }
      if (e.kind === "tool_use") {
        const body = e.text.replace(/^[^\n]*\n/, ""); // drop the native "X tool use: name" prefix line
        return `**Tool call (${renderedToolName(e, target)}):**\n${body}`;
      }
      return `**Tool result:**\n${e.text.replace(/^[^\n]*\n/, "")}`;
    })
    .join("\n\n");

  return `${header}\n${body}\n`;
}

export interface ConvertResult {
  provider: ConvAgent;
  target: ConvAgent;
  sessionId: string;
  title: string;
  events: number;
  path: string; // written transcript
}

/** Convert a session to a portable handoff transcript for `target`; writes it and returns meta. */
export async function convertSession(ref: string, target: ConvAgent): Promise<ConvertResult> {
  const session = await resolveSession(ref);
  if (!session) throw new Error(`No session found for "${ref}"`);
  if (session.sourceProvider === target) throw new Error(`Session is already a ${target} session`);
  const transcript = renderTranscript(session, target);
  await mkdir(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${session.sourceProvider}-${session.sourceSessionID}-to-${target}.md`);
  await writeFile(out, transcript);
  return {
    provider: session.sourceProvider,
    target,
    sessionId: session.sourceSessionID,
    title: session.title,
    events: session.events.length,
    path: out,
  };
}
