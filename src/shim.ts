#!/usr/bin/env bun
// PATH-shim gate for codex workers, which have no per-command hook. The worker launches with
// a shim dir first on PATH containing `git` and `gh` wrappers; each wrapper runs
//   bun shim.ts <realbin> <args...>
// which applies the same gitguard as claude/opencode. Allowed → exec the real binary; denied →
// print the reason and exit non-zero. NOTE: a PATH shim is bypassable by calling the binary by
// absolute path, so it is a softer gate than the claude/opencode hooks (documented in README).

import { spawnSync } from "node:child_process";
import { classifyWorkerCommand, DEFAULT_CAPS, type WorkerCaps } from "./gitguard.js";

function caps(): WorkerCaps {
  try {
    return { ...DEFAULT_CAPS(), ...JSON.parse(process.env.WALKIE_CAPS ?? "{}") };
  } catch {
    return DEFAULT_CAPS();
  }
}

/** Decide on a shimmed invocation. argv is [realBin, ...args] as the wrapper received them. */
export function shimDecide(
  realBin: string,
  args: string[],
  c: WorkerCaps,
): { allow: true } | { allow: false; reason: string } {
  const name = realBin.split("/").pop() ?? realBin; // git | gh
  // Reconstruct a single command line for the classifier (quote args with spaces).
  const cmd = [name, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
  return classifyWorkerCommand(cmd, c);
}

if (import.meta.main) {
  const [realBin, ...args] = process.argv.slice(2);
  if (!realBin) process.exit(0);
  const d = shimDecide(realBin, args, caps());
  if (!d.allow) {
    process.stderr.write(`walkie gate blocked this ${realBin.split("/").pop()} command: ${d.reason}\n`);
    process.exit(1);
  }
  const r = spawnSync(realBin, args, { stdio: "inherit" });
  process.exit(r.status ?? 0);
}
