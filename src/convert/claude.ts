// Claude Code session adapter: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// One JSON object per line; user/assistant lines carry message.content (string or block array).

import { basename } from "node:path";
import {
  bounded,
  type CanonicalEvent,
  type CanonicalRole,
  type CanonicalSession,
  cleanTitle,
  looksInjected,
  readJsonl,
  universalOperation,
} from "./core.js";

export function parseClaudeSession(path: string, text: string): CanonicalSession | null {
  const objects = readJsonl(text);
  if (objects.length === 0) return null;

  let sessionID = basename(path).replace(/\.jsonl$/, "");
  let cwd = "";
  let title: string | undefined;
  let model: string | undefined;
  const events: CanonicalEvent[] = [];

  for (const o of objects) {
    if (typeof o.sessionId === "string") sessionID = o.sessionId;
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (typeof o.aiTitle === "string") title = o.aiTitle; // latest re-title wins
    if ((o.type === "user" || o.type === "assistant") && o.message) {
      const role: CanonicalRole = o.type === "assistant" ? "assistant" : "user";
      if (!model && typeof o.message.model === "string") model = o.message.model;
      pushClaudeEvents(events, o.message.content, role);
    }
  }
  if (events.length === 0) return null;

  const firstUser = events.find((e) => e.role === "user" && e.kind === "message" && !looksInjected(e.text));
  const resolvedTitle = cleanTitle(title) ?? cleanTitle(firstUser?.text) ?? `Claude session ${sessionID}`;
  return {
    sourceProvider: "claude",
    sourceSessionID: sessionID,
    sourcePath: path,
    title: resolvedTitle,
    cwd,
    model,
    events,
  };
}

function pushClaudeEvents(events: CanonicalEvent[], content: unknown, role: CanonicalRole): void {
  if (typeof content === "string") {
    if (content && !looksInjected(content)) {
      events.push({ sourceProvider: "claude", role, kind: "message", text: bounded(content) });
    }
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    const t = item?.type;
    if (t === "text" && typeof item.text === "string" && item.text && !looksInjected(item.text)) {
      events.push({ sourceProvider: "claude", role, kind: "message", text: bounded(item.text) });
    } else if (t === "tool_use") {
      const name = item.name ?? "tool";
      const input = bounded(JSON.stringify(item.input ?? {}, null, 2), 12_000);
      events.push({
        sourceProvider: "claude",
        role: "tool",
        kind: "tool_use",
        text: `Claude tool use: ${name}\n${input}`,
        toolName: name,
        toolOp: universalOperation("claude", name),
      });
    } else if (t === "tool_result") {
      const c = item.content;
      const result = bounded(typeof c === "string" ? c : JSON.stringify(c ?? "", null, 2), 20_000);
      events.push({
        sourceProvider: "claude",
        role: "tool",
        kind: "tool_result",
        text: `Claude tool result:\n${result}`,
      });
    }
  }
}
