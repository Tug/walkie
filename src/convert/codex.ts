// Codex CLI session ("rollout") adapter: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// JSONL of {type, payload}. The authoritative transcript is the response_item stream (message /
// function_call / *_tool_call[_output]); reasoning is provider-private and dropped; event_msg
// user_message is the best title source.

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

const codexRole = (r: string): CanonicalRole =>
  r === "assistant" ? "assistant" : r === "developer" ? "developer" : r === "system" ? "system" : "user";

function messageText(payload: any): string {
  const c = payload.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return typeof payload.message === "string" ? payload.message : "";
}

export function parseCodexSession(path: string, text: string): CanonicalSession | null {
  const objects = readJsonl(text);
  if (objects.length === 0) return null;

  let sessionID =
    basename(path).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/)?.[1] ?? basename(path).replace(/\.jsonl$/, "");
  let cwd = "";
  let model: string | undefined;
  let title: string | undefined;
  const events: CanonicalEvent[] = [];

  for (const o of objects) {
    const p = o.payload;
    if (o.type === "session_meta" && p) {
      sessionID = p.session_id ?? p.id ?? sessionID;
      cwd = p.cwd ?? cwd;
    } else if (o.type === "turn_context" && p) {
      cwd = p.cwd ?? cwd;
      model = p.model ?? model;
    } else if (o.type === "event_msg" && p?.type === "user_message" && !title) {
      const m = typeof p.message === "string" ? p.message : "";
      if (m && !looksInjected(m)) title = m;
    } else if (o.type === "response_item" && p) {
      pushCodexEvent(events, p, model);
      if (!title) {
        const last = events[events.length - 1];
        if (last?.role === "user" && last.kind === "message" && !looksInjected(last.text)) title = last.text;
      }
    }
  }
  if (events.length === 0) return null;
  return {
    sourceProvider: "codex",
    sourceSessionID: sessionID,
    sourcePath: path,
    title: cleanTitle(title) ?? `Codex session ${sessionID}`,
    cwd,
    model,
    events,
  };
}

function pushCodexEvent(events: CanonicalEvent[], p: any, model: string | undefined): void {
  switch (p.type) {
    case "message": {
      const role = codexRole(p.role ?? "user");
      const text = bounded(messageText(p));
      if (text && (role === "assistant" || !looksInjected(text))) {
        events.push({ sourceProvider: "codex", role, kind: "message", text });
      }
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const name = p.name ?? "function_call";
      const args = bounded(
        p.arguments ?? p.input ?? JSON.stringify(p.arguments ?? p.input ?? "", null, 2),
        12_000,
      );
      events.push({
        sourceProvider: "codex",
        role: "tool",
        kind: "tool_use",
        text: `Codex tool use: ${name}\n${args}`,
        toolName: name,
        toolOp: universalOperation("codex", name),
      });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const out = p.output;
      const result = bounded(typeof out === "string" ? out : JSON.stringify(out ?? "", null, 2), 20_000);
      events.push({
        sourceProvider: "codex",
        role: "tool",
        kind: "tool_result",
        text: `Codex tool result:\n${result}`,
      });
      return;
    }
    // reasoning and everything else: dropped (provider-private / not transcript).
  }
  void model;
}
