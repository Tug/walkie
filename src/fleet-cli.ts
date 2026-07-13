// CLI-in-tmux worker backend. Each worker is an interactive `claude` session in its own tmux
// session + git worktree, so it can be joined locally (`tmux attach`) and remote-controlled to
// a phone. It runs on your claude.ai subscription (not API credits) and is gated by the
// PreToolUse hook (src/hook.ts) under --permission-mode dontAsk (never bypass). The walkie
// server is the only coordinator; there is no supervisor and no merge-queue.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { WorkerCaps } from "./gitguard.js";
import type { RepoPolicy } from "./policy.js";
import { capturePane, sendKeysRobust } from "./tmux.js";

const exec = promisify(execFile);
const ROOT = join(homedir(), ".fleet-orchestrator", "cli");
const REPOS = join(ROOT, "repos");
const WTS = join(ROOT, "wts");
const STATE = join(ROOT, "fleet.json");
const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), "hook.ts");
const REMOTE_CONTROL = process.env.WALKIE_REMOTE_CONTROL === "on";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export interface CliWorker {
  name: string;
  repo: string;
  branch: string;
  task: string;
  worktree: string;
  tmuxSession: string;
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
): Promise<SpawnResult> {
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

  // Settings that install our gate hook and disable prompts (the hook is the sole gate).
  const settingsPath = join(worktree, ".walkie-settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        permissions: { defaultMode: "dontAsk" },
        hooks: { PreToolUse: { type: "command", command: `bun ${HOOK_PATH}` } },
      },
      null,
      2,
    ),
  );

  // Launch interactive claude in its own tmux session, in the worktree, gated + subscription-billed.
  const claudeArgs = [
    "--settings",
    settingsPath,
    "--permission-mode",
    "dontAsk",
    ...(REMOTE_CONTROL ? ["--remote-control", name] : []),
  ];
  const capsJson = JSON.stringify(caps).replace(/'/g, "'\\''");
  const launch = `WALKIE_CAPS='${capsJson}' ${CLAUDE_BIN} ${claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  await sh("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", worktree, launch]);

  const worker: CliWorker = {
    name,
    repo: policy.name,
    branch,
    task,
    worktree,
    tmuxSession,
    caps,
    createdAt: new Date().toISOString(),
  };
  s.workers[name] = worker;
  await saveState(s);

  // Give claude a moment to boot, clear a first-run trust prompt if any, then send the task.
  void primeAndSend(tmuxSession, base, caps, worktree, task);
  return { name, branch, tmuxSession, remoteControl: REMOTE_CONTROL };
}

async function primeAndSend(
  session: string,
  base: string,
  caps: WorkerCaps,
  worktree: string,
  task: string,
): Promise<void> {
  const conventions = await readConventions(worktree);
  const target = `${session}:0`;
  try {
    // Poll for readiness / trust prompt for up to ~30s.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!(await tmuxHas(session))) return; // killed before it was primed
      const pane = await capturePane(target, 40);
      if (/Do you trust the files in this folder\?/.test(pane)) {
        await sendKeysRobust(target, "1");
        continue;
      }
      if (/❯|Try "|esc to interrupt|Welcome/.test(pane)) break; // prompt is ready
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
      const status = /esc to interrupt/.test(pane)
        ? "working"
        : /Do you trust the files/.test(pane)
          ? "blocked:trust"
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
