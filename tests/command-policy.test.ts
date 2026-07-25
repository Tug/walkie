import { describe, expect, test } from "bun:test";
import { commandDenied, DEFAULT_DENY, loadCommandPolicy, matchesGlob } from "../src/command-policy.js";
import { classifyWorkerCommand, DEFAULT_CAPS } from "../src/gitguard.js";

describe("matchesGlob", () => {
  test("prefix globs and exact", () => {
    expect(matchesGlob("gh workflow run deploy.yml", "gh workflow run*")).toBe(true);
    expect(matchesGlob("gh  workflow   run x", "gh workflow run*")).toBe(true); // whitespace-normalized
    expect(matchesGlob("git push origin main", "gh workflow run*")).toBe(false);
  });
});

describe("commandDenied with defaults", () => {
  const policy = { deny: DEFAULT_DENY, allow: [] };
  test("blocks deploys and publishes by default", () => {
    expect(commandDenied("gh workflow run deploy-prod.yml", policy).denied).toBe(true);
    expect(commandDenied("npm publish", policy).denied).toBe(true);
    expect(commandDenied("gh release create v1", policy).denied).toBe(true);
  });
  test("allows ordinary commands", () => {
    expect(commandDenied("bun test", policy).denied).toBe(false);
    expect(commandDenied("gh pr create", policy).denied).toBe(false);
  });
  test("allow list rescues a denied command", () => {
    expect(
      commandDenied("gh workflow run safe.yml", { deny: DEFAULT_DENY, allow: ["gh workflow run safe.yml"] })
        .denied,
    ).toBe(false);
  });
});

describe("loadCommandPolicy merges env onto defaults", () => {
  test("WALKIE_DENY extends defaults; WALKIE_ALLOW sets exceptions", () => {
    const p = loadCommandPolicy({
      WALKIE_DENY: '["kubectl *"]',
      WALKIE_ALLOW: '["npm publish --dry-run*"]',
    } as NodeJS.ProcessEnv);
    expect(p.deny).toContain("kubectl *");
    expect(p.deny).toContain("gh workflow run*"); // defaults still present
    expect(p.allow).toContain("npm publish --dry-run*");
  });
});

describe("gitguard applies the command policy", () => {
  test("a worker's deny pattern blocks the command through classifyWorkerCommand", () => {
    const caps = { ...DEFAULT_CAPS("main"), deny: ["gh workflow run*"] };
    expect(classifyWorkerCommand("gh workflow run deploy.yml", caps).allow).toBe(false);
    expect(classifyWorkerCommand("bun run build", caps).allow).toBe(true);
  });
});
