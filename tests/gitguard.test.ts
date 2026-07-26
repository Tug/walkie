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
      deny: [],
      allow: [],
    };
    noW("git push --no-verify origin main", all); // skips repo checks
    noW("git remote set-url origin git@evil:x/y.git", all);
    noW("git push origin main; gh pr merge 1", all); // shell chaining
    noW("git push --all origin", all);
  });

  test("global options before the subcommand cannot bypass the gates", () => {
    // Naive `sub = rest[0]` used to read "-c"/"-C"/"-R" as the subcommand and skip the gate.
    noW("git -c user.email=x@y.z push origin main"); // push-to-main still caught
    noW("git -c a=b -c c=d push origin main"); // multiple globals
    noW("gh -R owner/repo pr merge 1"); // merge still caught
    noW("gh --repo owner/repo pr merge 1");
    noW("gh -R=owner/repo pr merge 1"); // inline value form
    // Directory redirection escapes the worktree entirely: denied outright.
    noW("git -C /some/other/repo push origin feature");
    noW("git --git-dir=/other/.git push origin feature");
    noW("git --work-tree=/other push origin feature");
    // -c core.hooksPath=... disables hooks like --no-verify: denied.
    noW("git -c core.hooksPath=/dev/null push origin feature");
    // A benign global option before an allowed push still works.
    okW("git -c user.email=x@y.z push origin feat/x");
    okW("gh -R owner/repo pr create --fill");
    okW("gh -R owner/repo pr merge 1", { ...def, allowMerge: true });
  });
});
