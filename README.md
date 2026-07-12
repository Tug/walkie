# walkie

A walkie-talkie for your Claude fleet. Hands-free steering of a local multi-agent system:
ask what's going on, unblock agents, spawn workers, from your phone or by voice, while the
fleet itself runs entirely on your own machine.

Three layers:

1. **Fleet**: walkie's own native backend runs single-task Claude Agent SDK workers, each in
   its own git worktree, following the target repo's conventions and gated by a capability
   guard (see [Fleet safety](#fleet-safety-native-backend)). No daemon, no autonomous
   supervisor, no merge-queue: the walkie server is the only coordinator and acts only on your
   explicit requests. (An earlier version wrapped [multiclaude](https://github.com/dlorenc/multiclaude);
   it was dropped after it merged to main and pushed to teammates' branches on its own.)
2. **Resident orchestrator**: a persistent Claude Agent SDK session on this machine that
   inspects the fleet (status, logs, PRs) under a strict command allowlist and answers in
   short, voice-friendly prose. Summarization happens here, so remote clients only ever
   receive small digests.
3. **MCP surface**: streamable HTTP MCP with bearer auth (or Google Workspace SSO), so any
   remote client (claude.ai custom connector, OpenAI Realtime voice session, another Claude
   Code) can pilot the fleet.

## Run

```bash
bun install
export FLEET_TOKEN="$(openssl rand -hex 24)"   # keep it somewhere safe
bun start                                       # listens on 127.0.0.1:8787
```

Env:

- `FLEET_TOKEN` (required): bearer token for every MCP request.
- `FLEET_CONTROL=off`: hide the write tools (spawn_worker, send_to_agent) for a read-only surface.
- `WALKIE_REPOS` (required to spawn): JSON allowlist of repos, default-deny.
- `PORT` (default 8787).

## Tools

Read lane (deterministic): `fleet_status` (includes worker status), `agent_output`
(a worker's activity log), `task_history`.
Brain: `ask_orchestrator` (preferred for open questions; summaries happen Mac-side).
Control lane: `spawn_worker`, `reset_orchestrator`.

## Worker status

Each native worker reports its lifecycle into `fleet_status`, sourced from the Agent SDK run
(not terminal scraping): `starting` → `working` → `done` / `error`, or `killed`. Each carries
`createdAt` / `updatedAt` and a short `summary` on completion, so a voice answer can say
"one worker done, one still working" without any LLM reading terminals.

> Legacy: a tmux pane-hash health poller and the gastown-derived `send_to_agent` tmux delivery
> remain in the tree from the multiclaude era. They do not apply to native workers (which are
> not tmux sessions) and are slated for removal or replacement by a native "message a running
> worker" path.

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

## Fleet safety (native backend)

The 2026 incident that shaped this was **unrequested autonomous action**: multiclaude's
merge-queue agent (prompted to auto-merge) merged to main, and its supervisor (prompted to
auto-dispatch) spawned workers nobody asked for. So walkie does **not** use multiclaude's
`init` topology, no daemon, no supervisor, no merge-queue agent. The walkie server is the
only coordinator and acts only on explicit `spawn_worker` requests.

Each worker runs in its own git worktree off `origin/<base>` and **follows the repository's
own conventions** (its `AGENTS.md`/`CLAUDE.md` is injected into the worker prompt), including
branch naming and pre-commit/pre-push checks. Normal work is unrestricted, a worker may create
and push feature branches and open PRs, which fits trunk-based development.

The three irreversible / outward actions are **capabilities, off by default**, granted per
worker only when the user explicitly asks, and enabling any of them requires the user's
verbatim consent phrase (`I give explicit consent to remove this`) passed to `spawn_worker`:

- `allowMainPush` — push the base branch directly
- `allowMerge` — `gh pr merge` / merge via API
- `allowForcePush` — force-push

The command guard (`src/gitguard.ts`) enforces these per-worker, and always blocks
`--no-verify` (it would skip the repo's own checks) and remote retargeting. So "fix X and
merge to main" works when you say so; an agent doing it unprompted cannot.

Repos are **default-deny**: walkie refuses any repo not in `WALKIE_REPOS`. Example:

```
WALKIE_REPOS='[{"name":"my-toy","url":"git@github.com:me/my-toy.git","defaultBranch":"main"}]'
```

The guard is the primary enforcement (command-parsing, so strong but not cryptographic). For a
*hard* guarantee on shared repos, run the fleet under a dedicated bot identity whose token
cannot merge and can only push allowed refs, plus branch protection on the base branch. See
DEPLOY.md.

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

Design informed by prior art: [multiclaude](https://github.com/dlorenc/multiclaude) (the
original wrapped backend, since replaced by the native one) and the tmux delivery protocol
adapted from [gastown](https://github.com/gastownhall/gastown) (MIT); blocked-prompt detection
concept from claude-squad (AGPL: concept only, no code); structured-log ideas from
vibe-kanban (Apache-2.0).
