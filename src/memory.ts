// Per-project memory: one JSON record per worker run, so the fleet learns which agent/model/
// approach works for a given repo, and a human (or the router) can search it. Records live at
// $WALKIE_MEMORY_DIR/<repo>/runs/<id>.json (default ~/.fleet-orchestrator/memory).

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const memDir = (): string =>
  process.env.WALKIE_MEMORY_DIR ?? join(homedir(), ".fleet-orchestrator", "memory");

export interface RunRetro {
  right?: string; // what went well
  wrong?: string; // what went wrong
  improve?: string; // what to do differently next time
}

export interface RunRecord {
  id: string;
  ts: string; // ISO
  repo: string;
  worker: string;
  agent: string;
  model?: string;
  task: string;
  branch?: string;
  caps?: { allowMainPush?: boolean; allowMerge?: boolean; allowForcePush?: boolean };
  outcome?: string; // freeform, e.g. "PR #12 opened, CI green" or "abandoned: build broke"
  retro?: RunRetro;
  harness?: string; // suggestions to improve walkie/the harness itself
  tags?: string[];
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "unknown";
}

/** Persist a run record (id/ts assigned if missing). Returns the stored record. */
export async function recordRun(
  rec: Omit<RunRecord, "id" | "ts"> & Partial<Pick<RunRecord, "id" | "ts">>,
): Promise<RunRecord> {
  const id = rec.id ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const full: RunRecord = { ...rec, id, ts: rec.ts ?? new Date().toISOString() };
  const dir = join(memDir(), slug(full.repo), "runs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(full, null, 2));
  return full;
}

async function readAll(repo?: string): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  let repos: string[];
  try {
    repos = repo ? [slug(repo)] : await readdir(memDir());
  } catch {
    return out;
  }
  for (const r of repos) {
    const dir = join(memDir(), r, "runs");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, f), "utf8")));
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

const HAY = (r: RunRecord): string =>
  [
    r.task,
    r.agent,
    r.model,
    r.outcome,
    r.retro?.right,
    r.retro?.wrong,
    r.retro?.improve,
    r.harness,
    ...(r.tags ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

/** Keyword search across records (all terms scored by occurrence); newest-first on ties. */
export async function searchMemory(query: string, repo?: string, limit = 20): Promise<RunRecord[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const records = await readAll(repo);
  if (terms.length === 0) return records.slice(0, limit);
  return records
    .map((r) => {
      const h = HAY(r);
      const score = terms.reduce((n, t) => n + (h.includes(t) ? 1 : 0), 0);
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.ts.localeCompare(a.r.ts))
    .slice(0, limit)
    .map((x) => x.r);
}

export async function recentRuns(repo?: string, n = 20): Promise<RunRecord[]> {
  return (await readAll(repo)).slice(0, n);
}
