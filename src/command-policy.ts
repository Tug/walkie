// Configurable command allow/deny policy, the primary safety gate now that repos are
// ungated. Deny patterns block a command outright (e.g. deploying to prod via `gh workflow
// run`, publishing a package); allow patterns are exceptions that override a deny. Patterns
// are simple globs (`*` = any run of chars) matched against the normalized command line.
// Config via WALKIE_DENY / WALKIE_ALLOW (JSON arrays), merged on top of safe defaults.

export interface CommandPolicy {
  deny: string[];
  allow: string[];
}

// Sensible defaults: block deploys, releases, secret writes, and package publishes. These are
// the "escapes the repo / ships to the world" actions that per-worker caps don't cover. Users
// can add more via WALKIE_DENY or carve exceptions via WALKIE_ALLOW.
export const DEFAULT_DENY: string[] = [
  "gh workflow run*",
  "gh workflow enable*",
  "gh workflow disable*",
  "gh run rerun*",
  "gh release create*",
  "gh release delete*",
  "gh secret set*",
  "gh secret delete*",
  "npm publish*",
  "pnpm publish*",
  "yarn publish*",
  "bun publish*",
];

function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

export function matchesGlob(cmd: string, pattern: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${pattern.split("*").map(esc).join(".*")}$`);
  return re.test(normalize(cmd));
}

/** A command is denied if it matches a deny pattern and no allow pattern rescues it. */
export function commandDenied(cmd: string, policy: CommandPolicy): { denied: boolean; pattern?: string } {
  if (policy.allow.some((p) => matchesGlob(cmd, p))) return { denied: false };
  const hit = policy.deny.find((p) => matchesGlob(cmd, p));
  return hit ? { denied: true, pattern: hit } : { denied: false };
}

export function loadCommandPolicy(env: NodeJS.ProcessEnv = process.env): CommandPolicy {
  const parse = (v: string | undefined): string[] => {
    if (!v) return [];
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    deny: [...DEFAULT_DENY, ...parse(env.WALKIE_DENY)],
    allow: parse(env.WALKIE_ALLOW),
  };
}
