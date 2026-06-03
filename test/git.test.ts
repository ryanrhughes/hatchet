import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as git from "../src/helpers/git";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hatchet-git-test-"));
  tempDirs.push(dir);
  return dir;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(): string {
  const repo = join(tempDir(), "repo");
  runGit(["init", repo], originalCwd);
  runGit(["config", "user.email", "test@example.com"], repo);
  runGit(["config", "user.name", "Hatchet Test"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  runGit(["add", "README.md"], repo);
  runGit(["commit", "-m", "initial|with pipe"], repo);
  return repo;
}

afterEach(() => {
  process.chdir(originalCwd);
  git.clearCache();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("git helpers", () => {
  test("creates sanitized worktrees and parses commit messages with pipes", () => {
    const repo = createRepo();
    process.chdir(repo);
    git.clearCache();

    const result = git.createWorktree("Feature/Test Branch");
    expect(result.branch).toBe("feature/test-branch");

    const status = git.getBranchStatus(result.path);
    expect(status.hasUpstream).toBe(false);
    expect(status.recentCommits[0].message).toBe("initial|with pipe");
  });
});
