// Per-agent-CLI drivers. All three run as an interactive session in a tmux window + git
// worktree (joinable, remote-controllable) and share one capability gate (src/gitguard.ts):
//   - claude:   --permission-mode dontAsk + PreToolUse hook (src/hook.ts)
//   - opencode: a tool.execute.before plugin that runs gitguard (throw = deny)
//   - codex:    --sandbox workspace-write + network on + a git/gh PATH-shim (src/shim.ts)
// Launch-command construction and gating-file generation live here; fleet-cli orchestrates.

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerCaps } from "./gitguard.js";

export type AgentKind = "claude" | "opencode" | "codex";
export const AGENT_KINDS: AgentKind[] = ["claude", "opencode", "codex"];
export const isAgentKind = (v: string): v is AgentKind => (AGENT_KINDS as string[]).includes(v);

const SRC = dirname(fileURLToPath(import.meta.url));
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`; // single-quote for the shell

/** Normalize a claude --model value so common spoken/typed forms work. The CLI accepts a bare
 * alias for the latest model ('opus', 'sonnet', 'haiku', 'fable') or a full id ('claude-opus-5').
 * A versioned-but-unprefixed form like 'opus-5' or 'opus 5' is NOT valid on its own, so map it to
 * the full id 'claude-opus-5'. Anything else is left untouched (the CLI will reject a bad name). */
export function normalizeClaudeModel(model: string): string {
  const s = model.trim().toLowerCase().replace(/\s+/g, "-");
  if (/^(opus|sonnet|haiku|fable)$/.test(s)) return s; // valid latest-model alias
  if (s.startsWith("claude-")) return s; // already a full id
  const versioned = s.match(/^(opus|sonnet|haiku|fable)-?([\d][\d.-]*)$/);
  if (versioned) return `claude-${versioned[1]}-${versioned[2]}`;
  return model;
}

/** Default model per agent when the caller doesn't specify one. Claude uses the subscription. */
export function resolveModel(kind: AgentKind, model?: string): string | undefined {
  if (model) return kind === "claude" ? normalizeClaudeModel(model) : model;
  if (kind === "opencode") return "anthropic/claude-sonnet-4-5"; // safe default; override per task
  return undefined; // claude: subscription default; codex: config default
}

export interface AgentContext {
  worktree: string;
  caps: WorkerCaps;
  base: string;
  model?: string;
}

export interface LaunchPlan {
  /** Env vars to export before the binary (WALKIE_CAPS always; PATH prepend for codex). */
  env: Record<string, string>;
  /** The binary + args, already shell-quoted. */
  command: string;
}

/** Readiness / trust / working signatures for priming and status (per CLI TUI). */
export interface AgentSignals {
  ready: RegExp;
  working: RegExp;
  trust?: { pattern: RegExp; send: string };
}

export function agentSignals(kind: AgentKind): AgentSignals {
  switch (kind) {
    case "claude":
      return {
        // Match the input box / greeting, but NOT the "❯" that also marks the trust menu's
        // selected option — otherwise the primer thinks the worker is ready and fires the task
        // text into the trust selector, derailing (and often exiting) the worker.
        ready: /Try "|Welcome|shortcuts|for shortcuts/,
        working: /esc to interrupt/,
        // Wording drifts across CLI versions; match the current "Quick safety check" screen and
        // the older phrasing. send "1" selects "Yes, I trust this folder".
        trust: {
          pattern:
            /Do you trust the files in this folder\?|Is this a project you created or one you trust|trust this folder/i,
          send: "1",
        },
      };
    case "opencode":
      return { ready: /❯|opencode|\bready\b/i, working: /working|thinking|running/i };
    case "codex":
      return { ready: /❯|codex|▌/i, working: /working|thinking|running/i };
  }
}

// ---- gating file generation + launch, per agent ----

async function prepareClaude(ctx: AgentContext, bin: string): Promise<LaunchPlan> {
  const settings = join(ctx.worktree, ".walkie-settings.json");
  await writeFile(
    settings,
    JSON.stringify(
      {
        permissions: { defaultMode: "dontAsk" },
        // PreToolUse must be an ARRAY of matchers, each with its own hooks array. The older
        // object form is silently ignored by current Claude Code, which would leave the worker
        // UNGATED. Match Bash (the hook allows every other tool itself); gitguard is the gate.
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `bun ${join(SRC, "hook.ts")}` }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  const args = ["--settings", settings, "--permission-mode", "dontAsk"];
  if (ctx.model) args.push("--model", ctx.model);
  return { env: {}, command: `${bin} ${args.map(sh).join(" ")}` };
}

async function prepareOpencode(ctx: AgentContext, bin: string): Promise<LaunchPlan> {
  // Plugin gate: tool.execute.before runs gitguard; throw = deny. Reads caps from env.
  const pluginDir = join(ctx.worktree, ".opencode", "plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "walkie-gate.ts"),
    `import { classifyWorkerCommand } from ${JSON.stringify(join(SRC, "gitguard.ts"))};
export const WalkieGate = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "bash") return;
    const caps = (() => { try { return JSON.parse(process.env.WALKIE_CAPS || "{}"); } catch { return {}; } })();
    const merged = { mainBranch: "main", allowMainPush: false, allowMerge: false, allowForcePush: false, ...caps };
    const d = classifyWorkerCommand(String(output.args?.command ?? ""), merged);
    if (!d.allow) throw new Error("walkie gate: " + d.reason);
  },
});
`,
  );
  // Config: sensible auto-permission (the plugin is the real gate) + model.
  await writeFile(
    join(ctx.worktree, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        permission: { bash: "allow", edit: "allow", webfetch: "allow" },
      },
      null,
      2,
    ),
  );
  const args: string[] = [];
  if (ctx.model) args.push("--model", ctx.model);
  return { env: {}, command: `${bin} ${args.map(sh).join(" ")}`.trimEnd() };
}

async function prepareCodex(ctx: AgentContext, bin: string): Promise<LaunchPlan> {
  // PATH-shim: a dir with git/gh wrappers that route through src/shim.ts before the real binary.
  const shimDir = join(ctx.worktree, ".walkie-shim");
  await mkdir(shimDir, { recursive: true });
  for (const tool of ["git", "gh"]) {
    const p = join(shimDir, tool);
    await writeFile(
      p,
      `#!/bin/bash\nexec bun ${sh(join(SRC, "shim.ts"))} "$(command -v -p ${tool} || echo /usr/bin/${tool})" "$@"\n`,
    );
    await chmod(p, 0o755);
  }
  const args = [
    "--cd",
    ctx.worktree,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    // Relaxed posture (per decision): allow network inside workspace-write so it can push/PR;
    // the PATH-shim gates git/gh. Config value is parsed as TOML.
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
  if (ctx.model) args.push("-m", ctx.model);
  return {
    env: { PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    command: `${bin} ${args.map(sh).join(" ")}`,
  };
}

const BIN_ENV: Record<AgentKind, string> = {
  claude: "CLAUDE_BIN",
  opencode: "OPENCODE_BIN",
  codex: "CODEX_BIN",
};

/** Write the agent's gating files and return how to launch it (env + command). */
export async function prepareAgent(kind: AgentKind, ctx: AgentContext): Promise<LaunchPlan> {
  const bin = process.env[BIN_ENV[kind]] ?? kind;
  if (kind === "claude") return prepareClaude(ctx, bin);
  if (kind === "opencode") return prepareOpencode(ctx, bin);
  return prepareCodex(ctx, bin);
}
