import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSignals, prepareAgent, resolveModel } from "../src/agents.js";
import { DEFAULT_CAPS } from "../src/gitguard.js";

const ctx = async () => ({
  worktree: await mkdtemp(join(tmpdir(), "walkie-wt-")),
  caps: DEFAULT_CAPS("main"),
  base: "main",
});
const exists = async (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

describe("resolveModel", () => {
  test("respects explicit model; defaults per agent", () => {
    expect(resolveModel("opencode", "moonshot/kimi-k3")).toBe("moonshot/kimi-k3");
    expect(resolveModel("opencode")).toContain("/"); // a provider/model default
    expect(resolveModel("claude")).toBeUndefined(); // subscription default
    expect(resolveModel("codex")).toBeUndefined();
  });
});

describe("prepareAgent — claude", () => {
  test("writes settings with the PreToolUse hook and dontAsk", async () => {
    const c = await ctx();
    const plan = await prepareAgent("claude", { ...c, model: undefined });
    expect(plan.command).toContain("--permission-mode");
    expect(plan.command).toContain("dontAsk");
    expect(await exists(join(c.worktree, ".walkie-settings.json"))).toBe(true);
    const s = JSON.parse(await readFile(join(c.worktree, ".walkie-settings.json"), "utf8"));
    expect(s.hooks.PreToolUse.command).toContain("hook.ts");
  });
});

describe("prepareAgent — opencode", () => {
  test("writes gate plugin + config, model flag when given", async () => {
    const c = await ctx();
    const plan = await prepareAgent("opencode", { ...c, model: "moonshot/kimi-k3" });
    expect(await exists(join(c.worktree, ".opencode/plugin/walkie-gate.ts"))).toBe(true);
    expect(await exists(join(c.worktree, "opencode.json"))).toBe(true);
    const plugin = await readFile(join(c.worktree, ".opencode/plugin/walkie-gate.ts"), "utf8");
    expect(plugin).toContain("tool.execute.before");
    expect(plugin).toContain("classifyWorkerCommand");
    expect(plan.command).toContain("moonshot/kimi-k3");
  });
});

describe("prepareAgent — codex", () => {
  test("writes executable git/gh shims and a network-enabled sandbox command", async () => {
    const c = await ctx();
    const plan = await prepareAgent("codex", { ...c, model: "gpt-5.5" });
    expect(plan.command).toContain("workspace-write");
    expect(plan.command).toContain("--ask-for-approval");
    expect(plan.command).toContain("sandbox_workspace_write.network_access=true");
    expect(plan.command).toContain("gpt-5.5");
    expect(plan.env.PATH?.startsWith(join(c.worktree, ".walkie-shim"))).toBe(true);
    for (const tool of ["git", "gh"]) {
      const p = join(c.worktree, ".walkie-shim", tool);
      expect(await exists(p)).toBe(true);
      expect(await readFile(p, "utf8")).toContain("shim.ts");
    }
  });
});

describe("agentSignals", () => {
  test("each agent has ready + working signatures; claude has a trust prompt", () => {
    expect(agentSignals("claude").trust).toBeDefined();
    for (const k of ["claude", "opencode", "codex"] as const) {
      expect(agentSignals(k).ready).toBeInstanceOf(RegExp);
      expect(agentSignals(k).working).toBeInstanceOf(RegExp);
    }
  });
});
