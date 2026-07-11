import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { capturePane, sendKeysRobust } from "./tmux.js";

const exec = promisify(execFile);

const MC = process.env.MULTICLAUDE_BIN ?? join(homedir(), "go", "bin", "multiclaude");
const STATE_FILE = join(homedir(), ".multiclaude", "state.json");

async function run(bin: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout + (stderr ? `\n${stderr}` : "");
}

export interface FleetAgent {
  name: string;
  type: string;
  task?: string;
  tmux_window?: string;
}

export interface FleetRepo {
  name: string;
  github_url?: string;
  tmux_session?: string;
  agents: FleetAgent[];
}

export async function fleetStatus(): Promise<{ daemon: string; repos: FleetRepo[] }> {
  let daemon = "unknown";
  try {
    const out = await run(MC, ["status"]);
    daemon = /Daemon:\s*running/.test(out) ? "running" : "stopped";
  } catch {
    daemon = "unreachable";
  }
  let repos: FleetRepo[] = [];
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
    repos = Object.entries(raw.repos ?? {}).map(([name, r]: [string, any]) => ({
      name,
      github_url: r.github_url,
      tmux_session: r.tmux_session,
      agents: Object.entries(r.agents ?? {}).map(([an, a]: [string, any]) => ({
        name: an,
        type: a.type,
        task: a.task,
        tmux_window: a.tmux_window ?? an,
      })),
    }));
  } catch {
    // no state file yet: empty fleet
  }
  return { daemon, repos };
}

async function resolveSession(repo: string): Promise<string> {
  const { repos } = await fleetStatus();
  const r = repos.find((x) => x.name === repo);
  if (!r) throw new Error(`Unknown repo "${repo}". Known: ${repos.map((x) => x.name).join(", ") || "none"}`);
  return r.tmux_session ?? `mc-${repo}`;
}

export async function agentOutput(repo: string, agent: string, lines = 100): Promise<string> {
  const session = await resolveSession(repo);
  const n = Math.min(Math.max(lines, 10), 2000);
  return capturePane(`${session}:${agent}`, n);
}

export async function spawnWorker(repo: string, task: string): Promise<string> {
  return run(MC, ["worker", "create", task, "--repo", repo], 60_000);
}

export async function sendToAgent(repo: string, agent: string, text: string): Promise<string> {
  const session = await resolveSession(repo);
  const target = `${session}:${agent}`;
  await sendKeysRobust(target, text);
  return `Sent to ${target}`;
}

export async function taskHistory(repo: string): Promise<string> {
  return run(MC, ["history", repo]);
}
