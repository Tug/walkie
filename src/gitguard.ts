// Safety gate for a worker agent's shell commands, by capability, not by branch name.
//
// The 2026-07-12 incident was UNREQUESTED autonomous action (a self-merging merge-queue
// agent + an auto-dispatching supervisor), not workers pushing branches. So a worker may
// do normal work freely, including pushing feature branches and opening PRs, and only the
// irreversible / outward actions are gated to what the user explicitly authorized for that
// worker: pushing the repo's main branch, merging, and force-pushing. `--no-verify` is always
// blocked (it would skip the repo's own pre-commit/pre-push checks).

export interface WorkerCaps {
  mainBranch: string; // e.g. "main" — pushing here needs allowMainPush
  allowMainPush: boolean;
  allowMerge: boolean;
  allowForcePush: boolean;
}

export const DEFAULT_CAPS = (mainBranch = "main"): WorkerCaps => ({
  mainBranch,
  allowMainPush: false,
  allowMerge: false,
  allowForcePush: false,
});

export type Decision = { allow: true } | { allow: false; reason: string };
const DENY = (reason: string): Decision => ({ allow: false, reason });
const ALLOW: Decision = { allow: true };

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function hasShellComposition(cmd: string): boolean {
  const bare = cmd.replace(/"[^"]*"|'[^']*'/g, "");
  return /[;&|`]|\$\(|\|\||&&|>|<|\bxargs\b|\beval\b/.test(bare);
}

export function classifyWorkerCommand(cmd: string, caps: WorkerCaps): Decision {
  const trimmed = cmd.trim();
  if (hasShellComposition(trimmed)) {
    return DENY("shell composition (;, &&, |, `, $()) is not allowed; run one command at a time");
  }
  const t = tokenize(trimmed);
  if (t.length === 0) return DENY("empty command");
  const bin = t[0];
  if (bin !== "git" && bin !== "gh") return ALLOW; // confined by worktree cwd

  const rest = t.slice(1);
  const sub = rest[0];

  if (bin === "gh") {
    if (sub === "pr" && rest[1] === "merge") {
      return caps.allowMerge
        ? ALLOW
        : DENY("merging is not authorized for this worker (ask explicitly to enable)");
    }
    if (sub === "repo" && (rest[1] === "delete" || rest[1] === "archive"))
      return DENY("repo mutation not allowed");
    if (sub === "api") {
      const joined = rest.join(" ");
      if ((/\/merges?\b/.test(joined) || /pulls\/\d+\/merge/.test(joined)) && !caps.allowMerge) {
        return DENY("merging via gh api is not authorized for this worker");
      }
    }
    return ALLOW;
  }

  // git
  if (sub === "push") {
    const flags = rest.slice(1);
    if (flags.some((f) => f === "--force" || f === "-f" || f.startsWith("--force-with-lease"))) {
      if (!caps.allowForcePush)
        return DENY("force-push is not authorized for this worker (ask explicitly to enable)");
    }
    if (flags.some((f) => f === "--no-verify" || f === "-n")) {
      return DENY("--no-verify is not allowed (it would skip the repo's pre-commit/pre-push checks)");
    }
    if (flags.some((f) => f === "--mirror" || f === "--all"))
      return DENY("bulk push (--all/--mirror) is not allowed");
    const positional = flags.filter((f) => !f.startsWith("-"));
    if (positional.length === 0) {
      // Pushing the current branch. Safe unless the worktree is on main (checked by caller); allow.
      return ALLOW;
    }
    const [remote, ...refspecs] = positional;
    if (remote !== "origin") return DENY(`may only push to origin, not "${remote}"`);
    for (const ref of refspecs) {
      const dst = (ref.includes(":") ? ref.split(":")[1] : ref)
        .replace(/^refs\/heads\//, "")
        .replace(/^\+/, "");
      if (dst === caps.mainBranch && !caps.allowMainPush) {
        return DENY(
          `pushing "${caps.mainBranch}" is not authorized for this worker (ask explicitly to enable)`,
        );
      }
    }
    return ALLOW;
  }

  if (sub === "remote" && (rest[1] === "set-url" || rest[1] === "add" || rest[1] === "remove")) {
    return DENY("changing git remotes is not allowed");
  }
  if (sub === "config" && rest.some((a) => a.startsWith("remote.") || a.startsWith("url."))) {
    return DENY("changing remote git config is not allowed");
  }
  return ALLOW;
}
