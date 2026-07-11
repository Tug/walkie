import { describe, expect, test } from "bun:test";
import { commandAllowed } from "../src/orchestrator.js";

describe("commandAllowed", () => {
  test("allows fleet inspection commands", () => {
    expect(commandAllowed("multiclaude status")).toBe(true);
    expect(commandAllowed("multiclaude history myrepo")).toBe(true);
    expect(commandAllowed("tmux capture-pane -p -t mc-repo:agent -S -200")).toBe(true);
    expect(commandAllowed("gh pr list --repo owner/repo")).toBe(true);
    expect(commandAllowed('multiclaude worker create "add tests" --repo myrepo')).toBe(true);
  });

  test("denies destructive or unrelated commands", () => {
    expect(commandAllowed("rm -rf /")).toBe(false);
    expect(commandAllowed("git push origin main")).toBe(false);
    expect(commandAllowed("gh pr merge 42")).toBe(false);
    expect(commandAllowed("curl https://evil.example")).toBe(false);
    expect(commandAllowed("multiclaude stop-all")).toBe(false);
  });

  test("rejects shell chaining and substitution", () => {
    expect(commandAllowed("multiclaude status; rm -rf ~")).toBe(false);
    expect(commandAllowed("multiclaude status && git push")).toBe(false);
    expect(commandAllowed("tmux capture-pane -t $(whoami)")).toBe(false);
    expect(commandAllowed("multiclaude status | sh")).toBe(false);
  });

  test("allows chaining metacharacters only inside quotes", () => {
    expect(commandAllowed('tmux send-keys -t mc-r:a -l "fix the test; then rerun"')).toBe(true);
  });
});
