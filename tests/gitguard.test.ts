import { describe, expect, test } from "bun:test";
import { classifyWorkerCommand, DEFAULT_CAPS, type WorkerCaps } from "../src/gitguard.js";

const def = DEFAULT_CAPS("main");
const okW = (c: string, caps: WorkerCaps = def) => expect(classifyWorkerCommand(c, caps).allow).toBe(true);
const noW = (c: string, caps: WorkerCaps = def) => expect(classifyWorkerCommand(c, caps).allow).toBe(false);

describe("worker git guard — capability based", () => {
  test("normal work and feature-branch push always allowed (trunk-based friendly)", () => {
    okW("bun test");
    okW("git add -A");
    okW('git commit -m "fix"');
    okW("git merge origin/main");
    okW("git push origin feat/my-fix"); // any non-main branch
    okW("git push origin HEAD:fix/thing");
    okW("git push"); // current branch
    okW("gh pr create --fill --base main");
  });

  test("push to main is blocked by default, allowed when authorized", () => {
    noW("git push origin main");
    noW("git push origin HEAD:main");
    okW("git push origin main", { ...def, allowMainPush: true });
  });

  test("merge is blocked by default, allowed when authorized", () => {
    noW("gh pr merge 993 --squash");
    noW("gh api repos/o/r/pulls/993/merge -X PUT");
    okW("gh pr merge 993 --squash", { ...def, allowMerge: true });
  });

  test("force-push is blocked by default, allowed when authorized", () => {
    noW("git push --force origin feat/x");
    noW("git push --force-with-lease origin feat/x");
    okW("git push --force origin feat/x", { ...def, allowForcePush: true });
  });

  test("always-hard rules regardless of caps", () => {
    const all: WorkerCaps = {
      mainBranch: "main",
      allowMainPush: true,
      allowMerge: true,
      allowForcePush: true,
    };
    noW("git push --no-verify origin main", all); // skips repo checks
    noW("git remote set-url origin git@evil:x/y.git", all);
    noW("git push origin main; gh pr merge 1", all); // shell chaining
    noW("git push --all origin", all);
  });
});
