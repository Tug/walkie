import { describe, expect, test } from "bun:test";
import { parseClaudeSession } from "../src/convert/claude.js";
import { parseCodexSession } from "../src/convert/codex.js";
import { renderedToolName, universalOperation } from "../src/convert/core.js";
import { renderTranscript } from "../src/convert/index.js";

describe("tool taxonomy", () => {
  test("maps native → universal → target native", () => {
    expect(universalOperation("claude", "Bash")).toBe("shell.exec");
    expect(universalOperation("codex", "apply_patch")).toBe("file.edit");
    // A Claude Bash call rendered for codex/opencode:
    const ev = {
      sourceProvider: "claude" as const,
      role: "tool" as const,
      kind: "tool_use" as const,
      text: "",
      toolName: "Bash",
      toolOp: "shell.exec",
    };
    expect(renderedToolName(ev, "codex")).toBe("exec_command");
    expect(renderedToolName(ev, "opencode")).toBe("bash");
  });
});

describe("Claude adapter", () => {
  const jsonl = [
    JSON.stringify({ type: "mode", sessionId: "sess-1" }),
    JSON.stringify({
      type: "user",
      cwd: "/repo",
      message: { role: "user", content: "Fix the login bug" },
      timestamp: "2026-07-19T10:00:00Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", name: "Bash", id: "t1", input: { command: "npm test" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }),
  ].join("\n");

  test("parses messages + tool_use with taxonomy op, resolves title/cwd/model", () => {
    const s = parseClaudeSession("/x/sess-1.jsonl", jsonl);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.sourceSessionID).toBe("sess-1");
    expect(s.cwd).toBe("/repo");
    expect(s.model).toBe("claude-x");
    expect(s.title).toBe("Fix the login bug");
    const toolUse = s.events.find((e) => e.kind === "tool_use");
    expect(toolUse?.toolName).toBe("Bash");
    expect(toolUse?.toolOp).toBe("shell.exec");
    expect(s.events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  test("renders a codex-targeted transcript translating Bash → exec_command", () => {
    const s = parseClaudeSession("/x/sess-1.jsonl", jsonl);
    if (!s) throw new Error("parse failed");
    const md = renderTranscript(s, "codex");
    expect(md).toContain("Continued from a claude session into codex");
    expect(md).toContain("exec_command"); // translated tool name
    expect(md).not.toContain("Tool call (Bash)");
  });
});

describe("Codex adapter", () => {
  const rollout = [
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: "cx-1", cwd: "/repo" },
      timestamp: "2026-07-19T11:00:00Z",
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "Add retries to the worker" },
    }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/repo", model: "gpt-x" } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Add retries to the worker" }],
      },
    }),
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: "secret" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "shell", call_id: "c1", input: "ls" },
    }),
  ].join("\n");

  test("uses response_item stream, drops reasoning, maps shell → shell.exec", () => {
    const s = parseCodexSession("/x/rollout-2026-07-19T11-00-00-cx-1.jsonl", rollout);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.sourceSessionID).toBe("cx-1");
    expect(s.model).toBe("gpt-x");
    expect(s.title).toBe("Add retries to the worker");
    expect(s.events.some((e) => e.text.includes("secret"))).toBe(false); // reasoning dropped
    const toolUse = s.events.find((e) => e.kind === "tool_use");
    expect(toolUse?.toolOp).toBe("shell.exec");
    // Rendered for claude, shell → Bash
    expect(renderTranscript(s, "claude")).toContain("Tool call (Bash)");
  });
});
