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

## Mobile app (locked-screen voice)

The web client dies when a phone locks (iOS suspends the tab and the microphone).
`mobile/` is an Expo app with the same architecture (on-device MCP bridge, ephemeral
Realtime secrets, tap-to-approve) plus what a locked phone needs: `react-native-webrtc`
and iOS `UIBackgroundModes: [audio, voip]`, so the session keeps running in a pocket,
like a call. Uses native modules, so it runs as a custom dev client, not Expo Go.

```bash
cd mobile && bun install
bunx eas login                                   # Expo account
bunx eas device:create                           # register your iPhone (ad hoc)
bunx eas build --profile internal --platform ios # then install from the build link
```

Internal distribution installs straight from a link on registered devices, no TestFlight.
Requires an Apple Developer Program membership for the certificates. Point the app at the
walkie server URL (LAN IP or tunnel hostname) plus the fleet token; both persist on-device.
If iOS ever suspends the session mid-pocket, the planned hardening is CallKit via
react-native-callkeep so walkie sessions present as real calls.

### Same app in the browser (Expo web)

The app also targets the web: WebRTC goes through a platform adapter (`src/rtc.ts` native,
`src/rtc.web.ts` browser). Two ways to run it:

```bash
cd mobile && bun run web          # dev: Expo serves it, CORS on the server allows the origin
bun run --cwd mobile export:web   # prod: builds mobile/dist, served by walkie at /app
```

The `/app` route on the walkie server serves the exported build same-origin, so the desktop
browser client and the phone app are the same codebase. `public/voice.html` remains as a
zero-build fallback.

## Expose remotely

```bash
cloudflared tunnel --url http://localhost:8787   # quick tunnel for testing
```

For a stable hostname use a named Cloudflare tunnel. Remote clients call
`https://<host>/mcp` with header `Authorization: Bearer $FLEET_TOKEN`.

- claude.ai: Settings > Connectors > Add custom connector.
- OpenAI Realtime (voice): session tool `{type: "mcp", server_url, authorization}`;
  put `spawn_worker`/`send_to_agent` behind `require_approval`.

## Fleet safety (confined native backend)

walkie spawns its own single-task workers, it does **not** use multiclaude's `init` topology
(no daemon, no autonomous supervisor, no merge-queue agent). The walkie server is the only
coordinator and acts only on explicit `spawn_worker` requests. Each worker:

- runs in a throwaway git worktree on a fresh `walkie/<slug>` branch off `origin/<base>`;
- is gated by a command guard (`src/gitguard.ts`): it may commit, merge/rebase `origin/main`
  *in*, push **only its own branch**, and open a PR, and it can never merge (no `gh pr merge`,
  no merge API), force-push, `--no-verify`, retarget the remote, or push any other ref;
- opens a PR and stops; a human merges.

Repos are **default-deny**: walkie refuses any repo not in `WALKIE_REPOS` (JSON allowlist),
and the only supported mode is `confined`. Example:

```
WALKIE_REPOS='[{"name":"my-toy","url":"git@github.com:me/my-toy.git","mode":"confined"}]'
```

The command guard is the primary enforcement. For a *hard* guarantee on shared repos (so a
misbehaving agent physically cannot merge or push outside `walkie/*` regardless of the guard),
run the fleet under a dedicated bot identity whose token has no merge rights and push access
limited to `walkie/*`, plus branch protection on the default branch. See DEPLOY.md.

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
