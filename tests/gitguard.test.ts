import { describe, expect, test } from "bun:test";
import { classifyWorkerCommand } from "../src/gitguard.js";

const B = "walkie/fix-tests";
const ok = (c: string) => expect(classifyWorkerCommand(c, B).allow).toBe(true);
const no = (c: string) => expect(classifyWorkerCommand(c, B).allow).toBe(false);

describe("worker git guard", () => {
  test("allows normal work in the worktree", () => {
    ok("bun test");
    ok("npm run build");
    ok("git add -A");
    ok('git commit -m "fix"');
    ok("git fetch origin");
    ok("git merge origin/main");
    ok("git rebase origin/main");
    ok("git status");
    ok("git diff HEAD~1");
  });

  test("allows pushing only the own branch to origin, and opening a PR", () => {
    ok("git push");
    ok("git push origin walkie/fix-tests");
    ok("git push origin HEAD:walkie/fix-tests");
    ok("gh pr create --fill --base main");
    ok("gh pr view 42");
  });

  test("blocks pushing any other branch", () => {
    no("git push origin main");
    no("git push origin feat/someone-else");
    no("git push origin HEAD:main");
    no("git push upstream walkie/fix-tests");
  });

  test("blocks force, no-verify, and bulk pushes", () => {
    no("git push --force origin walkie/fix-tests");
    no("git push -f origin walkie/fix-tests");
    no("git push --force-with-lease origin walkie/fix-tests");
    no("git push --no-verify origin walkie/fix-tests");
    no("git push --all origin");
    no("git push --mirror origin");
  });

  test("never allows merging", () => {
    no("gh pr merge 993");
    no("gh pr merge 993 --squash");
    no("gh api repos/o/r/pulls/993/merge -X PUT");
    no("gh api -X PUT repos/o/r/merges");
  });

  test("blocks remote retargeting and shell composition", () => {
    no("git remote set-url origin git@evil:x/y.git");
    no("git push origin walkie/fix-tests; gh pr merge 993");
    no("git push origin walkie/fix-tests && rm -rf /");
    no("git push origin $(echo main)");
  });

  test("blocks gh api write methods, allows reads", () => {
    no("gh api -X POST repos/o/r/issues");
    ok("gh api repos/o/r/pulls/42");
  });
});
