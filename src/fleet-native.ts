// walkie's own minimal fleet backend. No daemon, no supervisor, no merge-queue, no
// autonomous dispatch: the walkie server is the only coordinator, and it acts only on
// explicit spawn requests. Each worker is a single-task Claude Agent SDK session in a
// throwaway git worktree that follows the repo's own conventions. Workers push feature
// branches and open PRs freely; pushing main, merging, and force-pushing are per-worker
// capabilities the user must explicitly grant (see gitguard).

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { classifyWorkerCommand, type WorkerCaps } from "./gitguard.js";
import type { RepoPolicy } from "./policy.js";

const exec = promisify(execFile);
const ROOT = join(homedir(), ".fleet-orchestrator", "native");
const REPOS = join(ROOT, "repos");
const WTS = join(ROOT, "wts");
const STATE = join(ROOT, "fleet.json");
const LOGS = join(ROOT, "logs");

export type WorkerStatus = "starting" | "working" | "done" | "error" | "killed";

export interface Worker {
  name: string;
  repo: string;
  branch: string;
  task: string;
  worktree: string;
  caps: WorkerCaps;
  status: WorkerStatus;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

interface FleetState {
  workers: Record<string, Worker>;
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
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

async function patchWorker(name: string, patch: Partial<Worker>): Promise<void> {
  const s = await loadState();
  if (!s.workers[name]) return;
  s.workers[name] = { ...s.workers[name], ...patch, updatedAt: new Date().toISOString() };
  await saveState(s);
}

const ADJ = ["swift", "clever", "calm", "brave", "keen", "lively", "gentle", "bright"];
const ANIMAL = ["otter", "finch", "lynx", "heron", "marten", "vole", "ibex", "wren"];
function workerName(seed: number): string {
  return `${ADJ[seed % ADJ.length]}-${ANIMAL[(seed >> 3) % ANIMAL.length]}-${seed.toString(36)}`;
}

function slugify(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}

function workerSystem(branch: string, base: string, caps: WorkerCaps, conventions: string): string {
  const elevated: string[] = [];
  if (caps.allowMainPush) elevated.push(`push directly to ${base}`);
  if (caps.allowMerge) elevated.push("merge PRs");
  if (caps.allowForcePush) elevated.push("force-push");
  const grant = elevated.length
    ? `You were explicitly authorized by the user to: ${elevated.join(", ")}. Use this only for the requested task.`
    : `You were NOT authorized to push ${base}, merge, or force-push. Open a PR and let a human review/merge.`;
  return `You are a walkie fleet worker on one task. You start on branch "${branch}" in a dedicated worktree off origin/${base}.

Follow this repository's own conventions (below) to the letter, including branch naming, commit style, and pre-commit/pre-push checks. You may create a properly-named branch per those conventions.

Authorization for this task: ${grant}
A command gate enforces these limits; do not try to work around it (e.g. --no-verify is blocked because it skips the repo's checks). To incorporate upstream, merge or rebase origin/${base} into your branch. When done, open or update a PR (and merge/push-${base} only if authorized above), then stop; if blocked, say precisely why.

--- repository conventions (its AGENTS.md/CLAUDE.md) ---
${conventions || "(none found in repo)"}`;
}

/** Read the repo's own agent conventions to inject into the worker prompt. */
async function readConventions(worktree: string): Promise<string> {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const txt = await readFile(join(worktree, f), "utf8");
      if (txt.trim()) return `# ${f}\n${txt.slice(0, 8000)}`;
    } catch {
      // next
    }
  }
  return "";
}

/** Ensure a bare-ish local clone of the repo exists and origin/<base> is current. */
async function ensureClone(policy: RepoPolicy): Promise<string> {
  const dir = join(REPOS, policy.name);
  await mkdir(REPOS, { recursive: true });
  try {
    await readFile(join(dir, "HEAD"), "utf8"); // exists?
    await git(dir, ["fetch", "origin", "--prune"]);
  } catch {
    await exec("git", ["clone", policy.url, dir], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  }
  return dir;
}

export interface SpawnResult {
  name: string;
  branch: string;
  worktree: string;
}

/** Elevated capabilities the user explicitly granted for this worker (default: none). */
export interface Grant {
  allowMainPush?: boolean;
  allowMerge?: boolean;
  allowForcePush?: boolean;
}

/** Create a worker for a task. Returns immediately; the agent runs in the background. */
export async function spawnNativeWorker(
  policy: RepoPolicy,
  task: string,
  grant: Grant = {},
): Promise<SpawnResult> {
  const clone = await ensureClone(policy);
  const base = policy.defaultBranch ?? "main";
  const s = await loadState();
  const seed = Object.keys(s.workers).length + 1;
  const name = workerName(seed);
  // A neutral starting branch; the worker renames per the repo's own convention.
  const branch = `${slugify(task)}-${seed.toString(36)}`;
  const worktree = join(WTS, policy.name, name);
  await mkdir(join(WTS, policy.name), { recursive: true });

  await git(clone, ["worktree", "add", "-b", branch, worktree, `origin/${base}`]);

  const caps: WorkerCaps = {
    mainBranch: base,
    allowMainPush: grant.allowMainPush ?? false,
    allowMerge: grant.allowMerge ?? false,
    allowForcePush: grant.allowForcePush ?? false,
  };

  const worker: Worker = {
    name,
    repo: policy.name,
    branch,
    task,
    worktree,
    caps,
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  s.workers[name] = worker;
  await saveState(s);

  void runWorker(worker, base); // fire and forget
  return { name, branch, worktree };
}

async function runWorker(worker: Worker, base: string): Promise<void> {
  await mkdir(LOGS, { recursive: true });
  const logFile = join(LOGS, `${worker.name}.jsonl`);
  const log = (o: object) =>
    appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`);
  await patchWorker(worker.name, { status: "working" });
  const caps = worker.caps;
  const conventions = await readConventions(worker.worktree);
  try {
    const q = query({
      prompt: worker.task,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: workerSystem(worker.branch, base, caps, conventions),
        },
        cwd: worker.worktree,
        // No allowedTools: everything falls through canUseTool (bare entries would shadow it).
        canUseTool: async (tool, input) => {
          if (tool === "Bash") {
            const cmd = String((input as { command?: string }).command ?? "");
            const d = classifyWorkerCommand(cmd, caps);
            if (!d.allow) {
              await log({ denied: cmd, reason: d.reason });
              return { behavior: "deny", message: `walkie guard: ${d.reason}` };
            }
          }
          // Read/Write/Edit/Grep/Glob etc. are confined to the worktree cwd.
          return { behavior: "allow", updatedInput: input };
        },
        maxTurns: 80,
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") await log({ assistant: true });
      if (msg.type === "result") {
        const ok = msg.subtype === "success";
        await log({ result: msg.subtype, text: ok ? msg.result : undefined });
        await patchWorker(worker.name, {
          status: ok ? "done" : "error",
          summary: ok ? String(msg.result).slice(0, 500) : `error: ${msg.subtype}`,
        });
      }
    }
  } catch (err) {
    await log({ fatal: (err as Error).message });
    await patchWorker(worker.name, { status: "error", summary: (err as Error).message.slice(0, 300) });
  }
}

export async function listNativeWorkers(repo?: string): Promise<Worker[]> {
  const s = await loadState();
  return Object.values(s.workers).filter((w) => !repo || w.repo === repo);
}

export async function nativeWorkerOutput(name: string, lines = 100): Promise<string> {
  try {
    const raw = await readFile(join(LOGS, `${name}.jsonl`), "utf8");
    return raw.trim().split("\n").slice(-lines).join("\n");
  } catch {
    return `No log for worker "${name}".`;
  }
}

/** Destructive: removes the worker's worktree and branch. Requires the caller to have consent. */
export async function killNativeWorker(name: string): Promise<string> {
  const s = await loadState();
  const w = s.workers[name];
  if (!w) return `No worker "${name}".`;
  const clone = join(REPOS, w.repo);
  try {
    await git(clone, ["worktree", "remove", "--force", w.worktree]);
  } catch {
    await rm(w.worktree, { recursive: true, force: true }).catch(() => {});
  }
  await git(clone, ["branch", "-D", w.branch]).catch(() => {});
  w.status = "killed";
  await saveState(s);
  return `Removed worker ${name} (worktree + local branch ${w.branch}). Its remote walkie/* branch, if pushed, is left for you to delete.`;
}
