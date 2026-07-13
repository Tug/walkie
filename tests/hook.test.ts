import { describe, expect, test } from "bun:test";
import { decideHook } from "../src/hook.js";

const caps = JSON.stringify({
  mainBranch: "main",
  allowMainPush: false,
  allowMerge: false,
  allowForcePush: false,
});
const decision = (o: string) => JSON.parse(o).hookSpecificOutput.permissionDecision;

describe("PreToolUse hook decisions", () => {
  test("non-Bash tools are allowed", () => {
    expect(decision(decideHook({ tool_name: "Edit", tool_input: { file_path: "a.ts" } }, caps))).toBe(
      "allow",
    );
    expect(decision(decideHook({ tool_name: "Read" }, caps))).toBe("allow");
  });

  test("safe Bash allowed, dangerous Bash denied per caps", () => {
    expect(decision(decideHook({ tool_name: "Bash", tool_input: { command: "bun test" } }, caps))).toBe(
      "allow",
    );
    expect(
      decision(decideHook({ tool_name: "Bash", tool_input: { command: "git push origin feat/x" } }, caps)),
    ).toBe("allow");
    expect(
      decision(decideHook({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, caps)),
    ).toBe("deny");
    expect(decision(decideHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" } }, caps))).toBe(
      "deny",
    );
  });

  test("caps elevate: main push allowed when authorized", () => {
    const elevated = JSON.stringify({ mainBranch: "main", allowMainPush: true });
    expect(
      decision(decideHook({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, elevated)),
    ).toBe("allow");
  });

  test("malformed caps fall back to safe defaults (deny main push)", () => {
    expect(
      decision(decideHook({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, "{bad")),
    ).toBe("deny");
  });
});
