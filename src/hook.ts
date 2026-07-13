#!/usr/bin/env bun
// PreToolUse hook for CLI-in-tmux workers. Claude Code runs this before each tool call
// (settings: permissionDecision "allow" suppresses the prompt, "deny" blocks). It is the
// sole gate for an unattended `--permission-mode dontAsk` worker: Bash goes through the same
// gitguard as the SDK backend; every other tool (Read/Edit/Grep/…) is allowed (confined to
// the worktree cwd). The worker's capabilities arrive as JSON in $WALKIE_CAPS.

import { classifyWorkerCommand, DEFAULT_CAPS, type WorkerCaps } from "./gitguard.js";

function out(permissionDecision: "allow" | "deny", permissionDecisionReason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
  });
}

export function decideHook(input: unknown, capsEnv: string | undefined): string {
  const ev = (input ?? {}) as { tool_name?: string; tool_input?: { command?: string } };
  if (ev.tool_name !== "Bash") return out("allow", "walkie: non-shell tool permitted in worktree");
  let caps: WorkerCaps;
  try {
    caps = { ...DEFAULT_CAPS(), ...JSON.parse(capsEnv ?? "{}") };
  } catch {
    caps = DEFAULT_CAPS();
  }
  const d = classifyWorkerCommand(String(ev.tool_input?.command ?? ""), caps);
  return d.allow ? out("allow", "walkie: permitted") : out("deny", `walkie: ${d.reason}`);
}

// Entry point: only run I/O when executed directly (not when imported by tests).
if (import.meta.main) {
  const raw = await Bun.stdin.text();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // malformed input → deny to be safe
    console.log(out("deny", "walkie: unparseable hook input"));
    process.exit(0);
  }
  console.log(decideHook(parsed, process.env.WALKIE_CAPS));
  process.exit(0);
}
