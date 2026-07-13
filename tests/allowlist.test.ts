import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { commandAllowed, writeAllowed } from "../src/orchestrator.js";

describe("orchestrator commandAllowed (inspection only)", () => {
  test("allows fleet inspection commands", () => {
    expect(commandAllowed("tmux capture-pane -p -t walkie-swift-otter:0 -S -200")).toBe(true);
    expect(commandAllowed("tmux list-sessions")).toBe(true);
    expect(commandAllowed("gh pr list --repo owner/repo")).toBe(true);
    expect(commandAllowed("gh run list")).toBe(true);
    expect(commandAllowed("git log --oneline -5")).toBe(true);
    expect(commandAllowed("cat /Users/x/.fleet-orchestrator/cli/fleet.json")).toBe(true);
    expect(commandAllowed("jq . fleet.json")).toBe(true);
  });

  test("denies steering, mutation, and unrelated commands", () => {
    expect(commandAllowed("tmux send-keys -t walkie-x:0 hi")).toBe(false); // orchestrator does not steer
    expect(commandAllowed("git push origin main")).toBe(false);
    expect(commandAllowed("gh pr merge 42")).toBe(false);
    expect(commandAllowed("rm -rf /")).toBe(false);
    expect(commandAllowed("curl https://evil.example")).toBe(false);
  });

  test("rejects shell chaining and substitution", () => {
    expect(commandAllowed("tmux list-sessions; rm -rf ~")).toBe(false);
    expect(commandAllowed("gh pr list && git push")).toBe(false);
    expect(commandAllowed("cat $(whoami)")).toBe(false);
    expect(commandAllowed("gh pr list | sh")).toBe(false);
  });
});

describe("writeAllowed", () => {
  test("allows journal and tasks in the state dir", () => {
    expect(writeAllowed(`${homedir()}/.fleet-orchestrator/journal.md`)).toBe(true);
    expect(writeAllowed(`${homedir()}/.fleet-orchestrator/tasks.md`)).toBe(true);
  });
  test("denies everything else", () => {
    expect(writeAllowed(`${homedir()}/.zshrc`)).toBe(false);
    expect(writeAllowed("/etc/hosts")).toBe(false);
    expect(writeAllowed(`${homedir()}/.fleet-orchestrator/../.ssh/config`)).toBe(false);
    expect(writeAllowed(`${homedir()}/Work/walkie/src/server.ts`)).toBe(false);
  });
});
