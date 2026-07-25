// CLI-in-tmux worker backend. Each worker is an interactive agent CLI (claude / opencode /
// codex) in its own tmux session + git worktree, so it can be joined locally (`tmux attach`)
// and, for claude, remote-controlled to a phone. Each is gated by the shared capability guard
// (src/gitguard.ts) via its agent driver (src/agents.ts). The walkie server is the only
// coordinator; there is no supervisor and no merge-queue.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentKind, agentSignals, prepareAgent, resolveModel } from "./agents.js";
import type { WorkerCaps } from "./gitguard.js";
import type { RepoPolicy } from "./policy.js";
import { capturePane, sendKeysRobust } from "./tmux.js";

const exec = promisify(execFile);
const ROOT = join(homedir(), ".fleet-orchestrator", "cli");
const REPOS = join(ROOT, "repos");
const WTS = join(ROOT, "wts");
const STATE = join(ROOT, "fleet.json");
const REMOTE_CONTROL = process.env.WALKIE_REMOTE_CONTROL === "on";

export interface CliWorker {
  name: string;
  repo: string;
  branch: string;
  task: string;
  worktree: string;
  tmuxSession: string;
  agent: AgentKind;
  model?: string;
  caps: WorkerCaps;
  createdAt: string;
}

interface FleetState {
  workers: Record<string, CliWorker>;
}

async function sh(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { stdout } = await exec(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function loadState(): Promise<FleetState> {
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    return { workers: {} };
  }
}

async function saveState(s: FleetState): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const tmp = `${STATE}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await exec("mv", [tmp, STATE]);
}

const ADJ = ["swift", "clever", "calm", "brave", "keen", "lively", "gentle", "bright"];
const ANIMAL = ["otter", "finch", "lynx", "heron", "marten", "vole", "ibex", "wren"];
const workerName = (seed: number) =>
  `${ADJ[seed % ADJ.length]}-${ANIMAL[(seed >> 3) % ANIMAL.length]}-${seed.toString(36)}`;
const slugify = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";

async function ensureClone(policy: RepoPolicy): Promise<string> {
  const dir = join(REPOS, policy.name);
  await mkdir(REPOS, { recursive: true });
  try {
    await readFile(join(dir, "HEAD"), "utf8");
    await sh("git", ["fetch", "origin", "--prune"], { cwd: dir });
  } catch {
    await sh("git", ["clone", policy.url, dir], { timeoutMs: 600_000 });
  }
  return dir;
}

async function tmuxHas(session: string): Promise<boolean> {
  try {
    await sh("tmux", ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

export interface Grant {
  allowMainPush?: boolean;
  allowMerge?: boolean;
  allowForcePush?: boolean;
}

const WORKER_PROMPT = (base: string, caps: WorkerCaps, conventions: string) => {
  const elevated = [
    caps.allowMainPush && `push ${base} directly`,
    caps.allowMerge && "merge PRs",
    caps.allowForcePush && "force-push",
  ].filter(Boolean);
  const grant = elevated.length
    ? `You are explicitly authorized to: ${elevated.join(", ")} (only for this task).`
    : `You are NOT authorized to push ${base}, merge, or force-push. Open a PR and let a human merge.`;
  return `Follow this repository's own conventions (below) to the letter, including branch naming, commit style, and pre-commit/pre-push checks; create a properly-named branch per those conventions. ${grant} A gate blocks disallowed git actions and --no-verify; do not fight it. When done, open or update a PR (and merge/push-${base} only if authorized), then stop. If blocked, say precisely why.

--- repository conventions ---
${conventions || "(none found)"}`;
};

async function readConventions(worktree: string): Promise<string> {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const txt = await readFile(join(worktree, f), "utf8");
      if (txt.trim()) return `# ${f}\n${txt.slice(0, 8000)}`;
    } catch {
      /* next */
    }
  }
  return "";
}

export interface SpawnResult {
  name: string;
  branch: string;
  tmuxSession: string;
  remoteControl: boolean;
}

export async function spawnCliWorker(
  policy: RepoPolicy,
  task: string,
  grant: Grant = {},
  opts: { agent?: AgentKind; model?: string } = {},
): Promise<SpawnResult> {
  const agent: AgentKind = opts.agent ?? "claude";
  const model = resolveModel(agent, opts.model);
  const clone = await ensureClone(policy);
  const base = policy.defaultBranch ?? "main";
  const s = await loadState();
  const seed = Object.keys(s.workers).length + 1;
  const name = workerName(seed);
  const branch = `${slugify(task)}-${seed.toString(36)}`;
  const worktree = join(WTS, policy.name, name);
  const tmuxSession = `walkie-${name}`;
  await mkdir(join(WTS, policy.name), { recursive: true });
  await sh("git", ["worktree", "add", "-b", branch, worktree, `origin/${base}`], { cwd: clone });

  const caps: WorkerCaps = {
    mainBranch: base,
    allowMainPush: grant.allowMainPush ?? false,
    allowMerge: grant.allowMerge ?? false,
    allowForcePush: grant.allowForcePush ?? false,
  };

  // Agent driver writes its gating files and returns how to launch it.
  const plan = await prepareAgent(agent, { worktree, caps, base, model });
  // Remote control is a claude-only feature (steer from phone); other CLIs join via tmux attach.
  const rc = agent === "claude" && REMOTE_CONTROL ? ` '--remote-control' '${name}'` : "";
  const envPrefix = Object.entries({ WALKIE_CAPS: JSON.stringify(caps), ...plan.env })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  const launch = `${envPrefix} ${plan.command}${rc}`;
  await sh("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", worktree, launch]);

  const worker: CliWorker = {
    name,
    repo: policy.name,
    branch,
    task,
    worktree,
    tmuxSession,
    agent,
    model,
    caps,
    createdAt: new Date().toISOString(),
  };
  s.workers[name] = worker;
  await saveState(s);

  // Give the CLI a moment to boot, clear a first-run trust prompt if any, then send the task.
  void primeAndSend(agent, tmuxSession, base, caps, worktree, task);
  return { name, branch, tmuxSession, remoteControl: agent === "claude" && REMOTE_CONTROL };
}

async function primeAndSend(
  agent: AgentKind,
  session: string,
  base: string,
  caps: WorkerCaps,
  worktree: string,
  task: string,
): Promise<void> {
  const conventions = await readConventions(worktree);
  const target = `${session}:0`;
  const sig = agentSignals(agent);
  try {
    // Poll for readiness / trust prompt for up to ~30s.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!(await tmuxHas(session))) return; // killed before it was primed
      const pane = await capturePane(target, 40);
      if (sig.trust?.pattern.test(pane)) {
        await sendKeysRobust(target, sig.trust.send);
        continue;
      }
      if (sig.ready.test(pane) || sig.working.test(pane)) break;
    }
    if (!(await tmuxHas(session))) return;
    const full = `${WORKER_PROMPT(base, caps, conventions)}\n\nTASK: ${task}`;
    await sendKeysRobust(target, full);
  } catch {
    // Session went away mid-prime (e.g. killed, or exited). Nothing to send.
  }
}

export async function listCliWorkers(repo?: string): Promise<Array<CliWorker & { status: string }>> {
  const s = await loadState();
  const workers = Object.values(s.workers).filter((w) => !repo || w.repo === repo);
  return Promise.all(
    workers.map(async (w) => {
      if (!(await tmuxHas(w.tmuxSession))) return { ...w, status: "ended" };
      let pane = "";
      try {
        pane = await capturePane(`${w.tmuxSession}:0`, 30);
      } catch {
        return { ...w, status: "ended" };
      }
      const sig = agentSignals(w.agent ?? "claude");
      const status = sig.trust?.pattern.test(pane)
        ? "blocked:trust"
        : sig.working.test(pane)
          ? "working"
          : "idle";
      return { ...w, status };
    }),
  );
}

export async function cliWorkerOutput(name: string, lines = 100): Promise<string> {
  const s = await loadState();
  const w = s.workers[name];
  if (!w) return `No worker "${name}".`;
  if (!(await tmuxHas(w.tmuxSession))) return `Worker "${name}" session has ended.`;
  return capturePane(`${w.tmuxSession}:0`, lines);
}

export async function messageCliWorker(name: string, text: string): Promise<string> {
  const s = await loadState();
  const w = s.workers[name];
  if (!w) return `No worker "${name}".`;
  if (!(await tmuxHas(w.tmuxSession))) return `Worker "${name}" session has ended; cannot message it.`;
  await sendKeysRobust(`${w.tmuxSession}:0`, text);
  return `Sent to ${name}.`;
}

export async function killCliWorker(name: string): Promise<string> {
  const s = await loadState();
  const w = s.workers[name];
  if (!w) return `No worker "${name}".`;
  await sh("tmux", ["kill-session", "-t", w.tmuxSession]).catch(() => {});
  const clone = join(REPOS, w.repo);
  await sh("git", ["worktree", "remove", "--force", w.worktree], { cwd: clone }).catch(async () => {
    await rm(w.worktree, { recursive: true, force: true }).catch(() => {});
  });
  await sh("git", ["branch", "-D", w.branch], { cwd: clone }).catch(() => {});
  delete s.workers[name];
  await saveState(s);
  return `Killed worker ${name} (tmux session + worktree + local branch ${w.branch}).`;
}
