# walkie

A walkie-talkie for your Claude fleet. Hands-free steering of a local multi-agent system:
ask what's going on, unblock agents, spawn workers, from your phone or by voice, while the
fleet itself runs entirely on your own machine.

Three layers:

1. **Fleet**: [multiclaude](https://github.com/dlorenc/multiclaude) runs Claude Code agents
   in tmux windows + git worktrees, one repo per tmux session, PRs gated by CI. Works with
   zero remote parts; walkie is optional by design.
2. **Resident orchestrator**: a persistent Claude Agent SDK session on this machine that
   inspects the fleet (status, logs, PRs) under a strict command allowlist and answers in
   short, voice-friendly prose. Summarization happens here, so remote clients only ever
   receive small digests.
3. **MCP surface**: streamable HTTP MCP with bearer auth, so any remote client
   (claude.ai custom connector, OpenAI Realtime voice session, another Claude Code) can
   pilot the fleet.

## Run

```bash
bun install
export FLEET_TOKEN="$(openssl rand -hex 24)"   # keep it somewhere safe
bun start                                       # listens on 127.0.0.1:8787
```

Env:

- `FLEET_TOKEN` (required): bearer token for every MCP request.
- `FLEET_CONTROL=off`: hide the write tools (spawn_worker, send_to_agent) for a read-only surface.
- `PORT` (default 8787), `MULTICLAUDE_BIN` (default ~/go/bin/multiclaude).

## Tools

Read lane (deterministic): `fleet_status` (includes live health), `agent_output`, `task_history`.
Brain: `ask_orchestrator` (preferred for open questions; summaries happen Mac-side).
Control lane: `spawn_worker`, `send_to_agent`, `reset_orchestrator`.

## Health model

A poller hashes each agent's pane every 5s and classifies:

- `working`: pane changing, or Claude Code's "esc to interrupt" status line visible
- `blocked`: pane stable and a known human-decision prompt is on screen (permission,
  trust, yes/no dialog), with the matched reason in `detail`
- `idle`: pane stable 45s with no prompt
- `dead`: tmux window gone

Each status carries `since` and `lastActivityAt`, so a voice answer can say
"one agent blocked 25 minutes on a permission prompt" without any LLM reading terminals.

## Message delivery

`send_to_agent` uses a hardened protocol (adapted from gastown's tmux scar tissue):
sanitize control characters, ESC plus a 600ms settle (below that, readline may turn
Enter into M-Enter and silently never submit), literal text in 512-byte chunks, then
Enter verified against pane content with backoff retries.

## Voice client

A self-contained web page at `/voice` for hands-free sessions over the OpenAI Realtime API
(default model `gpt-realtime-2.1-mini`, override with `WALKIE_REALTIME_MODEL`; voice via
`WALKIE_REALTIME_VOICE`). Requires `OPENAI_API_KEY` on the walkie server.

```
open http://127.0.0.1:8787/voice   # paste the fleet token, tap Connect, talk
```

How it works: the server mints a short-lived Realtime client secret (your OpenAI key never
reaches the browser); the page opens a WebRTC audio session, pulls walkie's tool list from
the local MCP endpoint, and registers every tool as a Realtime function tool. Tool calls are
executed by the browser against the same origin, so the fleet token and fleet data never
transit through OpenAI's tool plumbing (only what enters the conversation does), and no
public tunnel is needed for local use. Control-lane tools (spawn_worker, send_to_agent,
reset_orchestrator) pop a tap-to-approve dialog before executing.

## Expose remotely

```bash
cloudflared tunnel --url http://localhost:8787   # quick tunnel for testing
```

For a stable hostname use a named Cloudflare tunnel. Remote clients call
`https://<host>/mcp` with header `Authorization: Bearer $FLEET_TOKEN`.

- claude.ai: Settings > Connectors > Add custom connector.
- OpenAI Realtime (voice): session tool `{type: "mcp", server_url, authorization}`;
  put `spawn_worker`/`send_to_agent` behind `require_approval`.

## Security model

- Server binds to localhost only; the tunnel is the sole remote path.
- Bearer token required on every request (min 24 chars enforced).
- The orchestrator agent runs under a command allowlist (see `ALLOWED_COMMANDS` in
  `src/orchestrator.ts`): fleet inspection and steering only, no merges/pushes/edits,
  and chained shell commands are rejected. Widen it consciously.
- The MCP surface is remote code execution by intent. Treat `FLEET_TOKEN` like an SSH key.

## Development

```bash
bun test            # unit tests (sanitization, command allowlist)
bun run typecheck   # tsc, strict
bun run lint        # biome check
bun run lint:fix    # biome check --write
```

CI (GitHub Actions) runs Biome, tsc, and the tests on every push and PR.

## Credits

Fleet layer by [multiclaude](https://github.com/dlorenc/multiclaude) (default backend;
`src/fleet.ts` is the only backend-specific file, adapters welcome). Delivery protocol and
health taxonomy adapted from [gastown](https://github.com/gastownhall/gastown) (MIT).
Blocked-prompt detection concept from claude-squad (AGPL: concept only, no code).
Structured-log ideas from vibe-kanban (Apache-2.0).
