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
- `WALKIE_DENY` / `WALKIE_ALLOW` (optional): JSON glob arrays for the command policy (see Fleet safety).
- `PORT` (default 8787).

## Tools

Read lane (deterministic): `fleet_status` (each worker's status), `agent_output`
(a worker's live terminal), `task_history`.
Brain: `ask_orchestrator` (preferred for open questions; summaries happen Mac-side).
Control lane: `spawn_worker`, `send_to_agent` (message a running worker), `reset_orchestrator`.

## Worker runtime

Each worker is an interactive agent CLI in its own **tmux session** (`walkie-<name>`) and git
worktree. Consequences:

- **Joinable locally**: `tmux attach -t walkie-<name>` to watch or take over.
- **Remote-controllable** (claude only): set `WALKIE_REMOTE_CONTROL=on` and claude workers
  launch with `--remote-control`, so you can steer from the Claude mobile app / claude.ai/code.
- `fleet_status` reports each worker's live status (`working` / `idle` / `blocked:trust` /
  `ended`) from its tmux pane; `send_to_agent` types into the live session.

### Agents

`spawn_worker` takes `agent` ∈ `claude` | `opencode` | `codex` (default `claude`) and an
optional `model` (for opencode as `provider/model`, e.g. `moonshot/kimi-k3`, `zhipu/glm-5.2`,
`anthropic/…`, `openai/…`; opencode needs the provider's API key in the server env). All three
run gated by the shared capability guard (`src/gitguard.ts`), but the enforcement mechanism
differs per CLI:

| Agent | Billing | Gate | Strength |
|---|---|---|---|
| **claude** | claude.ai subscription | `--permission-mode dontAsk` + PreToolUse hook (`src/hook.ts`) | hard (intercepts the tool call) |
| **opencode** | provider API key | `tool.execute.before` plugin runs `gitguard`, throws = deny | hard (intercepts the tool call) |
| **codex** | provider API key | `--sandbox workspace-write` + network on + a `git`/`gh` PATH-shim (`src/shim.ts`) | soft (bypassable by absolute path) |

codex has no per-command hook, so its shim is bypassable (`/usr/bin/git …`); for shared repos
pair it with the credential backstop (see Fleet safety). Claude workers run on your
subscription; opencode/codex bill their provider API key.

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

Two build profiles (`mobile/eas.json`):

- `development` — dev client + Metro, for iterating (needs your Mac on the same network).
- `internal` — **standalone release build**: JS bundled, no Metro, no local network. Installs
  from a link on registered devices, no TestFlight. This is the one to use day-to-day.

```bash
bunx eas build --profile internal --platform ios   # then open the build link on the iPhone
```

Requires an Apple Developer Program membership for the certificates. The default server URL is
baked in from `app.json` → `extra.walkieServerUrl` (see below), so the app connects with no
typing; in `AUTH_MODE=google` you sign in once via `<url>/auth/login` on the phone and paste
the 7-day token. If iOS ever suspends the session mid-pocket, the planned hardening is CallKit
via react-native-callkeep so walkie sessions present as real calls.

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

## Exposing the machine (remote access)

The server binds `127.0.0.1:8787` by default. To reach it from your phone off-wifi, expose it
over a public HTTPS URL. Four methods, pick by what you have:

| Method | Stable URL | Needs | Best for |
|---|---|---|---|
| **Tailscale Funnel** (recommended) | yes | Tailscale login (free), no domain | personal, permanent |
| **Named Cloudflare tunnel** | yes | a domain on Cloudflare | your own domain |
| **Quick Cloudflare tunnel** | no (random, per run) | nothing | a 10-second throwaway test |
| **LAN** (`HOST=0.0.0.0`) | LAN IP | same wifi | local dev only |

With any tunnel, keep `HOST=127.0.0.1` (the tunnel connects to localhost, so the Mac is never
exposed on the LAN). The mobile app's default URL lives in `mobile/app.json` →
`extra.walkieServerUrl`; other clients (claude.ai connector at `https://<host>/mcp`, an OpenAI
Realtime voice session's `{type:"mcp", server_url, authorization}`) just take the URL.

### Tailscale Funnel (recommended)

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/tailscale
# 1. Log in (macOS GUI build: use the menu-bar app; the CLI login can be flaky)
$TS login
# 2. Enable Funnel for this node — one-time browser consent. Running the serve command
#    below prints the exact enable URL (https://login.tailscale.com/f/funnel?node=...).
# 3. Serve localhost:8787 publicly and persistently (survives reboot)
$TS funnel --bg 8787
$TS funnel status          # confirm; prints https://<machine>.<tailnet>.ts.net
```

Tailscale terminates TLS and proxies the public `https://<machine>.<tailnet>.ts.net` to
`localhost:8787`. Turn it off with `$TS funnel --https=443 off` (or `$TS serve reset`).

### Cloudflare tunnel

```bash
# Named (stable) — needs a domain on your Cloudflare account:
cloudflared tunnel login
cloudflared tunnel create walkie
cloudflared tunnel route dns walkie walkie.example.com
cloudflared tunnel run --url http://localhost:8787 walkie   # persist via a launchd service

# Quick (throwaway, random URL that changes each run) — no login, no domain:
cloudflared tunnel --url http://localhost:8787
```

For a Cloud Run deployment (public by default, but gateway-only — no fleet), see DEPLOY.md.

## Authentication

Two modes, set by `AUTH_MODE` (see `.env.example`):

- **`token`** (default): one shared bearer, `FLEET_TOKEN` (generate with `openssl rand -hex 24`).
  Zero setup; every request needs `Authorization: Bearer <token>`. Good for personal/solo use.
- **`google`**: Google Workspace SSO restricted to a domain (`GOOGLE_ALLOWED_DOMAIN`, default
  `juisci.com`). A signed 7-day session (HS256) is issued as an httpOnly cookie (web,
  same-origin) or handed to the mobile app via a `walkie://` deep link (one-tap sign-in).
  `FLEET_TOKEN`, if also set, still works as a bearer for machine clients (CI, connectors).

### Setting up the Google OAuth client

Needed only for `AUTH_MODE=google`. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
→ APIs & Services → Credentials → **Create credentials → OAuth client ID**:

1. Application type: **Web application**.
2. **Authorized redirect URIs** — add one `<PUBLIC_URL>/auth/callback` per environment you use:
   - local via tunnel: `https://<machine>.<tailnet>.ts.net/auth/callback`
   - Cloud Run: `https://<your-domain>/auth/callback`
   You do **not** register the mobile `walkie://` scheme with Google, the callback redirects to
   it server-side after Google is done, so Google only ever sees the HTTPS callback.
3. Copy the **client ID** and **client secret** into the server env:

```bash
# .env (local)
AUTH_MODE=google
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_ALLOWED_DOMAIN=juisci.com
SESSION_SECRET=$(openssl rand -hex 32)   # signs the 7-day sessions
PUBLIC_URL=https://<machine>.<tailnet>.ts.net   # must exactly match the redirect URI host
```

For Cloud Run these go in Secret Manager instead, see DEPLOY.md. Sign-in flow: browser →
`<PUBLIC_URL>/auth/login` sets the cookie; mobile → the app's "Sign in with Google" button
calls `/auth/login?client=app` and receives the session over `walkie://auth`.

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
| **Repos** | any you init | any repo you name (no gating; safety is per-command) |

Safety is **per-command, not per-repo** (any repo you name is fine, including shared ones).
Three layers, all in `src/gitguard.ts` and enforced identically across claude/opencode/codex:

1. **Per-worker capabilities**, off by default, granted only when you explicitly ask, and
   enabling any requires your verbatim consent phrase (`I give explicit consent to remove this`)
   on `spawn_worker`: `allowMainPush`, `allowMerge` (`gh pr merge`), `allowForcePush`.
2. **Configurable command policy** (`WALKIE_DENY` / `WALKIE_ALLOW`, JSON glob arrays) blocks
   arbitrary commands for *all* workers, with safe defaults (deploy/publish/secret actions like
   `gh workflow run`, `gh release create`, `npm publish`). Add your own (`kubectl *`, …) or carve
   exceptions via `WALKIE_ALLOW`.
3. **Always-hard rules**: `--no-verify` (skips the repo's checks) and remote retargeting are
   never allowed; shell chaining (`;`, `&&`, `|`) is rejected so nothing smuggles past.

So "fix X and merge to main" works when you say so; an agent deploying to prod or merging
unprompted cannot. The gate is command-parsing (strong, not cryptographic), and it's a hard
intercept for claude (PreToolUse hook) and opencode (plugin) but a bypassable PATH-shim for
codex. For a *hard* guarantee on shared repos, run the fleet under a bot identity whose token
cannot merge and can only push allowed refs, plus branch protection. See DEPLOY.md.

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
