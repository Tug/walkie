import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPS } from "../src/gitguard.js";
import { shimDecide } from "../src/shim.js";

const caps = DEFAULT_CAPS("main");

describe("codex PATH-shim decision (same gitguard)", () => {
  test("allows normal git and feature-branch push", () => {
    expect(shimDecide("/usr/bin/git", ["status"], caps).allow).toBe(true);
    expect(shimDecide("/usr/bin/git", ["push", "origin", "feat/x"], caps).allow).toBe(true);
  });
  test("blocks push to main, merge, force by default", () => {
    expect(shimDecide("/usr/bin/git", ["push", "origin", "main"], caps).allow).toBe(false);
    expect(shimDecide("/opt/homebrew/bin/gh", ["pr", "merge", "1"], caps).allow).toBe(false);
    expect(shimDecide("/usr/bin/git", ["push", "--force", "origin", "feat/x"], caps).allow).toBe(false);
  });
  test("respects elevated caps", () => {
    expect(
      shimDecide("/usr/bin/git", ["push", "origin", "main"], { ...caps, allowMainPush: true }).allow,
    ).toBe(true);
  });
});
