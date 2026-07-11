import { createHash } from "node:crypto";
import { fleetStatus } from "./fleet.js";
import { capturePane, windowExists } from "./tmux.js";

export type AgentState = "working" | "idle" | "blocked" | "dead";

export interface AgentHealth {
  status: AgentState;
  since: string; // ISO timestamp of when this status began
  lastActivityAt: string; // last observed pane change
  detail?: string; // e.g. which prompt signature matched
}

// Signals that the agent is paused on a human decision (concept borrowed from
// claude-squad's prompt detection; strings are Claude Code's own UI).
const BLOCKED_SIGNATURES: Array<{ re: RegExp; detail: string }> = [
  { re: /No, and tell Claude what to do differently/, detail: "permission prompt" },
  { re: /Do you trust the files in this folder\?/, detail: "trust prompt" },
  { re: /❯\s*1\.\s*Yes/, detail: "yes/no dialog" },
];

// Claude Code shows this in the status line while a turn is running.
const WORKING_SIGNATURE = /esc to interrupt/;

const POLL_MS = 5_000;
const IDLE_AFTER_MS = 45_000; // stable pane this long with no signature = idle

interface Track {
  hash: string;
  lastChangeAt: number;
  status: AgentState;
  statusSince: number;
  detail?: string;
}

const tracks = new Map<string, Track>();
let timer: NodeJS.Timeout | undefined;

function classify(pane: string, t: Track, now: number): { status: AgentState; detail?: string } {
  const blocked = BLOCKED_SIGNATURES.find((s) => s.re.test(pane));
  if (blocked) return { status: "blocked", detail: blocked.detail };
  if (WORKING_SIGNATURE.test(pane)) return { status: "working" };
  if (now - t.lastChangeAt < IDLE_AFTER_MS) return { status: "working" };
  return { status: "idle" };
}

async function probe(target: string, now: number): Promise<void> {
  if (!(await windowExists(target))) {
    const prev = tracks.get(target);
    if (prev?.status !== "dead") {
      tracks.set(target, { hash: "", lastChangeAt: now, status: "dead", statusSince: now });
    }
    return;
  }
  const pane = await capturePane(target, 60);
  const hash = createHash("sha256").update(pane).digest("hex");
  let t = tracks.get(target);
  if (!t) {
    t = { hash, lastChangeAt: now, status: "working", statusSince: now };
    tracks.set(target, t);
  }
  if (hash !== t.hash) {
    t.hash = hash;
    t.lastChangeAt = now;
  }
  const { status, detail } = classify(pane, t, now);
  if (status !== t.status) {
    t.status = status;
    t.statusSince = now;
    t.detail = detail;
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const { repos } = await fleetStatus();
  const targets: string[] = [];
  for (const repo of repos) {
    const session = repo.tmux_session ?? `mc-${repo.name}`;
    for (const agent of repo.agents) targets.push(`${session}:${agent.tmux_window ?? agent.name}`);
  }
  await Promise.allSettled(targets.map((t) => probe(t, now)));
  for (const key of tracks.keys()) if (!targets.includes(key)) tracks.delete(key);
}

/** Self-chaining poll: next tick is scheduled only after the current one completes. */
export function startHealthPoller(): void {
  if (timer) return;
  const loop = async () => {
    try {
      await tick();
    } catch {
      // fleet may be down; keep polling
    }
    timer = setTimeout(loop, POLL_MS);
  };
  timer = setTimeout(loop, 0);
}

export function getHealth(target: string): AgentHealth | undefined {
  const t = tracks.get(target);
  if (!t) return undefined;
  return {
    status: t.status,
    since: new Date(t.statusSince).toISOString(),
    lastActivityAt: new Date(t.lastChangeAt).toISOString(),
    detail: t.detail,
  };
}
