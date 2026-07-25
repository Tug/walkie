import { describe, expect, test } from "bun:test";
import type { RunRecord } from "../src/memory.js";
import { suggestAgent } from "../src/router.js";

const rec = (p: Partial<RunRecord>): RunRecord => ({
  id: "x",
  ts: new Date().toISOString(),
  repo: "r",
  worker: "w",
  agent: "claude",
  task: "",
  ...p,
});

describe("router heuristic (no memory)", () => {
  test("web/design → claude (subscription)", () => {
    const s = suggestAgent("build the react dashboard chart UI", []);
    expect(s.agent).toBe("claude");
  });
  test("terminal/systems → opencode + kimi", () => {
    const s = suggestAgent("refactor the shell automation scripts in rust", []);
    expect(s.agent).toBe("opencode");
    expect(s.model).toBe("moonshot/kimi-k3");
  });
  test("neutral → claude default", () => {
    expect(suggestAgent("update the changelog", []).agent).toBe("claude");
  });
});

describe("router uses memory when similar tasks succeeded", () => {
  test("prefers the agent that worked on similar tasks here", () => {
    const mem = [
      rec({
        agent: "opencode",
        model: "moonshot/kimi-k3",
        task: "refactor payment webhook handler",
        outcome: "PR opened, CI green",
      }),
      rec({
        agent: "opencode",
        model: "moonshot/kimi-k3",
        task: "refactor payment retry logic",
        outcome: "merged",
      }),
    ];
    const s = suggestAgent("refactor payment reconciliation logic", mem);
    expect(s.agent).toBe("opencode");
    expect(s.rationale).toContain("memory");
  });
  test("ignores failed similar runs", () => {
    const mem = [
      rec({ agent: "codex", task: "refactor payment webhook handler", outcome: "abandoned: build broke" }),
    ];
    const s = suggestAgent("refactor payment reconciliation logic", mem);
    expect(s.rationale).not.toContain("memory"); // falls back to heuristic
  });
});
