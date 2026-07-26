// Safety gate for a worker agent's shell commands, by capability, not by branch name.
//
// The 2026-07-12 incident was UNREQUESTED autonomous action (a self-merging merge-queue
// agent + an auto-dispatching supervisor), not workers pushing branches. So a worker may
// do normal work freely, including pushing feature branches and opening PRs, and only the
// irreversible / outward actions are gated to what the user explicitly authorized for that
// worker: pushing the repo's main branch, merging, and force-pushing. `--no-verify` is always
// blocked (it would skip the repo's own pre-commit/pre-push checks). A configurable command
// policy (caps.deny/allow) blocks arbitrary commands too (e.g. `gh workflow run` = deploy).

import { commandDenied } from "./command-policy.js";

export interface WorkerCaps {
  mainBranch: string; // e.g. "main" — pushing here needs allowMainPush
  allowMainPush: boolean;
  allowMerge: boolean;
  allowForcePush: boolean;
  // Configurable command policy (any tool, not just git): deny patterns block, allow rescues.
  deny: string[];
  allow: string[];
}

export const DEFAULT_CAPS = (mainBranch = "main"): WorkerCaps => ({
  mainBranch,
  allowMainPush: false,
  allowMerge: false,
  allowForcePush: false,
  deny: [],
  allow: [],
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
  // Configurable command policy first (deploys, publishes, and anything the user blocked).
  const policy = commandDenied(trimmed, { deny: caps.deny, allow: caps.allow });
  if (policy.denied) return DENY(`blocked by command policy: matches "${policy.pattern}"`);
  const t = tokenize(trimmed);
  if (t.length === 0) return DENY("empty command");
  const bin = t[0];
  if (bin !== "git" && bin !== "gh") return ALLOW; // confined by worktree cwd

  // git and gh both accept GLOBAL OPTIONS before the subcommand, so a naive `sub = rest[0]`
  // lets `git -c x=y push`, `git -C /dir push`, and `gh -R owner/repo pr merge` slip past every
  // gate below (the subcommand token is shifted). Strip the leading options first, and deny the
  // ones that escape the worktree (git -C / --git-dir / --work-tree) or disable hooks
  // (git -c core.hooksPath=...) — the same class of risk as --no-verify.
  const stripped = stripGlobals(bin, t.slice(1));
  if (stripped.deny) return DENY(stripped.deny);
  const { sub, args } = stripped;

  if (bin === "gh") {
    if (sub === "pr" && args[0] === "merge") {
      return caps.allowMerge
        ? ALLOW
        : DENY("merging is not authorized for this worker (ask explicitly to enable)");
    }
    if (sub === "repo" && (args[0] === "delete" || args[0] === "archive"))
      return DENY("repo mutation not allowed");
    if (sub === "api") {
      const joined = args.join(" ");
      if ((/\/merges?\b/.test(joined) || /pulls\/\d+\/merge/.test(joined)) && !caps.allowMerge) {
        return DENY("merging via gh api is not authorized for this worker");
      }
    }
    return ALLOW;
  }

  // git
  if (sub === "push") {
    const flags = args;
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

  if (sub === "remote" && (args[0] === "set-url" || args[0] === "add" || args[0] === "remove")) {
    return DENY("changing git remotes is not allowed");
  }
  if (sub === "config" && args.some((a) => a.startsWith("remote.") || a.startsWith("url."))) {
    return DENY("changing remote git config is not allowed");
  }
  return ALLOW;
}

/** Split leading global options (those before the subcommand) from `rest`, returning the real
 * subcommand + its args. git/gh place options like `-c`, `-C`, `--git-dir`, `-R`/`--repo` ahead
 * of the subcommand; some take the FOLLOWING token as their value (unless written `--opt=value`).
 * We deny git's directory-redirection options (they operate outside the confined worktree) and
 * `-c core.hooksPath=` (it bypasses the repo's hooks, like --no-verify). */
function stripGlobals(
  bin: string,
  rest: string[],
): { deny?: string; sub: string | undefined; args: string[] } {
  const valueOpts =
    bin === "git"
      ? new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"])
      : new Set(["-R", "--repo"]);
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    const tok = rest[i];
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
    const takesValue = valueOpts.has(name);
    const val = inlineVal ?? (takesValue ? rest[i + 1] : undefined);
    if (bin === "git") {
      if (name === "-C" || name === "--git-dir" || name === "--work-tree") {
        return {
          deny: `git ${name} (operating outside the worktree) is not allowed`,
          sub: undefined,
          args: [],
        };
      }
      if (name === "-c" && /^core\.hooksPath=/i.test(val ?? "")) {
        return {
          deny: "git -c core.hooksPath is not allowed (it would bypass the repo's hooks)",
          sub: undefined,
          args: [],
        };
      }
    }
    i += takesValue && inlineVal === undefined ? 2 : 1;
  }
  return { sub: rest[i], args: rest.slice(i + 1) };
}
