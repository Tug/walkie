import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let recordRun: typeof import("../src/memory.js").recordRun;
let searchMemory: typeof import("../src/memory.js").searchMemory;

beforeAll(async () => {
  process.env.WALKIE_MEMORY_DIR = await mkdtemp(join(tmpdir(), "walkie-mem-"));
  const m = await import("../src/memory.js");
  recordRun = m.recordRun;
  searchMemory = m.searchMemory;
});
afterAll(() => {
  delete process.env.WALKIE_MEMORY_DIR;
});

describe("project memory", () => {
  test("records and finds by keyword, scoped per repo", async () => {
    await recordRun({
      repo: "acme/api",
      worker: "w1",
      agent: "opencode",
      model: "moonshot/kimi-k3",
      task: "refactor the auth module",
      outcome: "PR #4 opened, CI green",
      retro: { right: "clean refactor" },
    });
    await recordRun({
      repo: "acme/api",
      worker: "w2",
      agent: "claude",
      task: "build the settings UI page",
      outcome: "PR #5 opened",
    });
    await recordRun({
      repo: "acme/web",
      worker: "w3",
      agent: "claude",
      task: "fix chart colors",
      outcome: "merged",
    });

    const auth = await searchMemory("auth refactor", "acme/api");
    expect(auth.length).toBe(1);
    expect(auth[0].agent).toBe("opencode");

    const web = await searchMemory("chart", "acme/api");
    expect(web.length).toBe(0); // scoped to acme/api

    const all = await searchMemory("chart");
    expect(all.length).toBe(1);
    expect(all[0].repo).toBe("acme/web");
  });
});
