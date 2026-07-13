# walkie

A walkie-talkie for your Claude fleet. Hands-free steering of a local multi-agent system:
ask what's going on, unblock agents, spawn workers, from your phone or by voice, while the
fleet itself runs entirely on your own machine.

Three layers:

1. **Fleet**: walkie's own native backend runs single-task Claude Agent SDK workers, each in
   its own git worktree, following the target repo's conventions and gated by a capability
   guard (see [Fleet safety](#fleet-safety)). No daemon, no autonomous supervisor, no
   merge-queue: the walkie server is the only coordinator and acts only on your explicit
   requests.
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

Read lane (deterministic): `fleet_status` (each worker's status), `agent_output`
(a worker's live terminal), `task_history`.
Brain: `ask_orchestrator` (preferred for open questions; summaries happen Mac-side).
Control lane: `spawn_worker`, `send_to_agent` (message a running worker), `reset_orchestrator`.

## Worker runtime

Each worker is an interactive `claude` session in its own **tmux session** (`walkie-<name>`)
and git worktree. Consequences:

- **Runs on your claude.ai subscription**, not API credits (the interactive CLI uses your
  login; the Agent SDK would be API-key-only).
- **Joinable locally**: `tmux attach -t walkie-<name>` to watch or take over.
- **Remote-controllable**: set `WALKIE_REMOTE_CONTROL=on` and each worker launches with
  `--remote-control`, so you can steer it from the Claude mobile app / claude.ai/code.
- `fleet_status` reports each worker's live status (`working` / `idle` / `blocked:trust` /
  `ended`) from its tmux pane; `send_to_agent` types into the live session.

The worker runs under `--permission-mode dontAsk` (never bypass) with a **PreToolUse hook**
(`src/hook.ts`) as the sole gate, so it works unattended without stalling on prompts.

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

## Fleet safety

walkie is built for pointing agents at repos you care about, including shared ones, so its
default is caution. Where [multiclaude](https://github.com/dlorenc/multiclaude) optimizes for
autonomous velocity (a supervisor that finds work and dispatches agents, a merge-queue that
merges green PRs on its own, workers in bypass-permissions mode), walkie inverts every one of
those defaults. Its workers run `--permission-mode dontAsk` (never bypass) and are gated by a
PreToolUse hook rather than trusting the agent:

| | multiclaude | walkie |
|---|---|---|
| **Who acts** | supervisor auto-dispatches workers | only you, via explicit `spawn_worker` |
| **Merging** | merge-queue merges green PRs | never, unless you grant it per worker |
| **Push to main** | allowed | off by default; per-worker grant |
| **Force-push** | allowed | off by default; per-worker grant |
| **Conventions** | its own prompts | the repo's own `AGENTS.md`/`CLAUDE.md` |
| **Repos** | any you init | default-deny allowlist (`WALKIE_REPOS`) |

A worker does normal work freely, creating and pushing feature branches and opening PRs,
which fits trunk-based development. The three irreversible actions are **capabilities, off by
default**, granted per worker only when you explicitly ask; enabling any of them requires your
verbatim consent phrase (`I give explicit consent to remove this`) passed to `spawn_worker`:

- `allowMainPush` — push the base branch directly
- `allowMerge` — `gh pr merge` / merge via API
- `allowForcePush` — force-push

The guard (`src/gitguard.ts`, applied via the PreToolUse hook `src/hook.ts`) enforces these per
worker and always blocks `--no-verify` (it would skip the repo's own checks) and remote
retargeting. So "fix X and merge to main" works when you say so; an agent doing it unprompted
cannot.

The guard is command-parsing, so strong but not cryptographic. For a *hard* guarantee on
shared repos, additionally run the fleet under a bot identity whose token cannot merge and can
only push allowed refs, plus branch protection on the base branch. See DEPLOY.md.

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
