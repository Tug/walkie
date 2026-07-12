// Safety gate for a confined worker agent's shell commands.
//
// A worker runs in a throwaway worktree on its OWN branch (walkie/<slug>). It may build,
// test, edit, commit, merge main IN, and push ITS OWN branch, and open a PR. It may NOT:
// merge anything (into main or via gh), force-push, bypass hooks, push any other ref, or
// retarget the remote. This is the primary enforcement; a credential backstop (a bot token
// that physically cannot merge / push outside walkie/*) is the recommended hard guarantee
// for shared repos and is documented separately.

export type Decision = { allow: true } | { allow: false; reason: string };

const DENY = (reason: string): Decision => ({ allow: false, reason });
const ALLOW: Decision = { allow: true };

// Split a command line into words, honoring simple single/double quotes.
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function hasShellComposition(cmd: string): boolean {
  // Strip quoted spans, then look for shell operators that could chain a second command.
  const bare = cmd.replace(/"[^"]*"|'[^']*'/g, "");
  return /[;&|`]|\$\(|\|\||&&|>|<|\bxargs\b|\beval\b/.test(bare);
}

/**
 * Classify a Bash command a worker wants to run. `ownBranch` is the only branch it may push.
 * Non-git/gh commands are allowed here (they are confined by cwd = the worktree); this gate
 * exists to stop remote-affecting git/gh operations that could escape the worktree.
 */
export function classifyWorkerCommand(cmd: string, ownBranch: string): Decision {
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

  // gh: only PR/inspection actions; never a merge, never a raw API merge.
  if (bin === "gh") {
    if (sub === "pr" && rest[1] === "merge") return DENY("merging PRs is never allowed");
    if (sub === "repo" && (rest[1] === "delete" || rest[1] === "archive"))
      return DENY("repo mutation not allowed");
    if (sub === "api") {
      const joined = rest.join(" ");
      if (/\/merges?\b/.test(joined) || /pulls\/\d+\/merge/.test(joined)) {
        return DENY("gh api merge endpoints are not allowed");
      }
      if (/-X\s*(PUT|POST|PATCH|DELETE)|--method\s*(PUT|POST|PATCH|DELETE)/i.test(joined)) {
        return DENY("gh api write methods are not allowed");
      }
    }
    return ALLOW;
  }

  // git
  if (sub === "push") {
    const flags = rest.slice(1);
    if (flags.some((f) => f === "--force" || f === "-f" || f.startsWith("--force-with-lease"))) {
      return DENY("force-push is never allowed");
    }
    if (flags.some((f) => f === "--no-verify" || f === "-n")) {
      return DENY("--no-verify is not allowed (cannot bypass hooks)");
    }
    if (flags.some((f) => f === "--mirror" || f === "--all" || f === "--tags")) {
      return DENY("bulk push (--all/--mirror/--tags) is not allowed");
    }
    // Positional args after `push`, excluding flags and flag values.
    const positional = flags.filter((f) => !f.startsWith("-"));
    // Accept: no positional (push current branch) OR push to origin the own branch only.
    if (positional.length === 0) return ALLOW; // current branch is ownBranch (worktree is pinned)
    const [remote, ...refspecs] = positional;
    if (remote !== "origin") return DENY(`may only push to origin, not "${remote}"`);
    for (const ref of refspecs) {
      // refspec forms: "walkie/x", "HEAD:walkie/x", "walkie/x:walkie/x", "+walkie/x" (force → already blocked)
      const dst = ref.includes(":") ? ref.split(":")[1] : ref;
      if (dst.replace(/^refs\/heads\//, "") !== ownBranch) {
        return DENY(`may only push branch "${ownBranch}", not "${dst}"`);
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

  // Everything else in git (add, commit, merge origin/main, rebase, fetch, status, diff, log,
  // checkout within the worktree) is allowed; it can only leave the worktree via push, gated above.
  return ALLOW;
}
