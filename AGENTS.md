# AGENTS.md — working on walkie itself

walkie is a hands-free orchestrator for a personal fleet of coding-agent CLIs. This file
orients an agent (or human) improving walkie's own code. It is injected into any worker
spawned on the walkie repo, so keep it accurate.

## What walkie is

A Bun + TypeScript MCP server (`src/server.ts`) on `127.0.0.1:8787`, exposed publicly via a
Tailscale Funnel, plus an Expo app (`mobile/`) and a zero-build web page (`public/voice.html`)
that drive it by voice over the OpenAI Realtime API. It spawns worker agents (claude / opencode
/ codex) in tmux + git worktrees and coordinates them; the user never edits the server by hand
while a session runs.

## Module map (`src/`)

- `server.ts` — MCP tools (fleet_status, agent_output, task_history, spawn_worker,
  send_to_agent, kill_worker, record_run, search_memory, suggest_agent, list_sessions,
  convert_session, ask_orchestrator) + Express routes; auth middleware; serves `/app` and `/voice`.
- `agents.ts` — per-CLI drivers: launch command + gating-file generation for claude/opencode/codex.
- `gitguard.ts` — THE safety gate. Capability model (main-push/merge/force off by default) +
  command policy. Shared by all three agents via `hook.ts` (claude PreToolUse), the opencode
  plugin (generated in agents.ts), and `shim.ts` (codex git/gh PATH-shim).
- `command-policy.ts` — configurable deny/allow globs (WALKIE_DENY/WALKIE_ALLOW), default-blocks deploys/publishes.
- `fleet-cli.ts` — worker lifecycle: clone/worktree, tmux launch, prime, status, message, kill, newRepo.
- `orchestrator.ts` — resident Claude Agent SDK session (read-only fleet inspection allowlist; writes only under ~/.fleet-orchestrator/).
- `memory.ts` / `router.ts` — per-repo run records + search; agent/model suggestion.
- `convert/` — session conversion (continuo port): adapters (claude/codex) → canonical → transcript.
- `auth.ts` — token or Google-Workspace SSO. `voice.ts` — Realtime ephemeral secret + the `/voice` page.

## Conventions

- Runtime: **bun** (`bun start`, `bun test`). Lint/format: **biome** (`bun run lint` = `biome ci .`, matches CI).
- Every change must pass `bunx biome ci .`, `bunx tsc`, and `bun test`. CI runs all three plus a mobile typecheck.
- **Safety is the point.** Any change touching `gitguard.ts`, `command-policy.ts`, `hook.ts`,
  `shim.ts`, or the opencode plugin needs tests, and must preserve: no merge/main-push/force
  without an explicit per-worker capability, `--no-verify` and remote-retargeting always blocked,
  shell chaining rejected. When in doubt, deny.
- Never weaken a gate to make a task pass. Never commit secrets; `.env` is gitignored.
- Match existing style; keep modules small and single-purpose. No em dashes in output.
- **Type safety (inspired by smoothie's AGENTS.md).** A finite set of values is NEVER typed as
  `string` — model it as a union of literals. In practice:
  - Zod tool inputs (`src/server.ts`): use `z.enum([...])` / `z.literal(...)`, never `z.string()`,
    when the domain is closed. Keep `z.string()` only for genuinely open values (repo refs, tasks,
    free text, worker names, a cross-provider `model` string).
  - One source of truth per enum: define it once (e.g. `AgentKindSchema` in `agents.ts`), derive the
    TS type (`z.infer`) and the runtime list (`.options`) from it, and reuse the schema in every tool
    `inputSchema` so the enum is exposed to MCP clients. No hand-kept parallel copies.
  - The orchestrator (`orchestrator.ts`) is an SDK agent, not an MCP client, so it does not receive
    the zod schema. Inject the same source constants into its system prompt so its advice can't name
    a value the tools would reject.
  - Banned: `any`, `as` (type assertions; `as const` is fine), `@ts-ignore`, non-null `!`. Narrow
    with type guards (`(x): x is T => ...`) instead of casting. Use discriminated unions for state.

## Self-improvement loop

walkie can be improved by spawning a worker on `Tug/walkie` (this repo). Trunk-based; open a PR,
CI must be green, a human merges. The local dev checkout is `~/Work/walkie`.
