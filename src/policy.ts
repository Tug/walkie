// Which repos walkie may operate on, and how. Default-deny: after the 2026-07-12 incident,
// walkie refuses any repo not explicitly allowed. Shared/org repos additionally require the
// operator to acknowledge confined mode.
//
// Config via WALKIE_REPOS (JSON array), e.g.:
//   [{"name":"my-toy","url":"git@github.com:me/my-toy.git","mode":"confined"}]
// mode: "confined" (only walkie/* branches, no merge; the sole supported mode today).

export interface RepoPolicy {
  name: string;
  url: string;
  mode: "confined";
  defaultBranch?: string; // base for new work branches; defaults to "main"
}

let cache: RepoPolicy[] | null = null;

export function loadRepoPolicies(env: NodeJS.ProcessEnv = process.env): RepoPolicy[] {
  if (cache) return cache;
  const raw = env.WALKIE_REPOS;
  if (!raw) return (cache = []);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WALKIE_REPOS is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("WALKIE_REPOS must be a JSON array");
  cache = parsed.map((r: any, i) => {
    if (!r?.name || !r?.url) throw new Error(`WALKIE_REPOS[${i}] needs name and url`);
    if (r.mode && r.mode !== "confined") throw new Error(`WALKIE_REPOS[${i}].mode must be "confined"`);
    return { name: r.name, url: r.url, mode: "confined", defaultBranch: r.defaultBranch ?? "main" };
  });
  return cache;
}

export function resetPolicyCache(): void {
  cache = null;
}

/** Returns the policy for a repo, or an explanation of why it is not permitted. */
export function repoPolicy(
  name: string,
  env?: NodeJS.ProcessEnv,
): { ok: true; policy: RepoPolicy } | { ok: false; reason: string } {
  const policies = loadRepoPolicies(env);
  const p = policies.find((x) => x.name === name);
  if (!p) {
    return {
      ok: false,
      reason:
        `Repo "${name}" is not in walkie's allowlist. walkie refuses repos it does not explicitly manage. ` +
        `Add it to WALKIE_REPOS with mode "confined" (walkie only ever creates walkie/* branches and never merges).`,
    };
  }
  return { ok: true, policy: p };
}
