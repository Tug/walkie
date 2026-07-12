import { describe, expect, test } from "bun:test";
import { loadRepoPolicies, repoPolicy, resetPolicyCache } from "../src/policy.js";

function env(repos?: unknown): NodeJS.ProcessEnv {
  resetPolicyCache();
  return (repos === undefined ? {} : { WALKIE_REPOS: JSON.stringify(repos) }) as NodeJS.ProcessEnv;
}

describe("repo policy (default-deny)", () => {
  test("refuses any repo when nothing is allowlisted", () => {
    const r = repoPolicy("smoothie", env());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("allowlist");
  });

  test("refuses a repo not in the allowlist", () => {
    const r = repoPolicy("smoothie", env([{ name: "my-toy", url: "git@github.com:me/my-toy.git" }]));
    expect(r.ok).toBe(false);
  });

  test("allows an explicitly allowlisted repo in confined mode", () => {
    const r = repoPolicy("my-toy", env([{ name: "my-toy", url: "git@github.com:me/my-toy.git" }]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.mode).toBe("confined");
      expect(r.policy.defaultBranch).toBe("main");
    }
  });

  test("rejects non-confined modes and malformed config", () => {
    expect(() => loadRepoPolicies(env([{ name: "x", url: "u", mode: "auto-merge" }]))).toThrow();
    resetPolicyCache();
    expect(() => loadRepoPolicies({ WALKIE_REPOS: "{not json" } as NodeJS.ProcessEnv)).toThrow();
  });
});
