import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSignals, normalizeClaudeModel, prepareAgent, resolveModel } from "../src/agents.js";
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

  test("normalizes claude model names so spoken/typed forms resolve", () => {
    // Valid aliases and full ids pass through (lowercased).
    expect(resolveModel("claude", "opus")).toBe("opus");
    expect(resolveModel("claude", "claude-opus-5")).toBe("claude-opus-5");
    // The invalid-but-common versioned form is repaired to the full id.
    expect(resolveModel("claude", "opus-5")).toBe("claude-opus-5");
    expect(resolveModel("claude", "opus 5")).toBe("claude-opus-5");
    expect(resolveModel("claude", "Opus5")).toBe("claude-opus-5");
    expect(resolveModel("claude", "sonnet-4-5")).toBe("claude-sonnet-4-5");
    // Non-claude agents are left exactly as given.
    expect(resolveModel("opencode", "opus-5")).toBe("opus-5");
  });
});

describe("normalizeClaudeModel", () => {
  test("aliases pass, versioned forms are prefixed, unknowns untouched", () => {
    expect(normalizeClaudeModel("opus")).toBe("opus");
    expect(normalizeClaudeModel("opus-5")).toBe("claude-opus-5");
    expect(normalizeClaudeModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(normalizeClaudeModel("gpt-5.5")).toBe("gpt-5.5"); // not a claude family name
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
    // PreToolUse must be an array of matchers (the object form is silently ignored → ungated).
    expect(Array.isArray(s.hooks.PreToolUse)).toBe(true);
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain("hook.ts");
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
