import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearConfigCache } from "../src/helpers/config";
import { copyWorktreeFiles, runPostWorktreeHooks } from "../src/helpers/project";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hatchet-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearConfigCache();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("copyWorktreeFiles", () => {
  test("copies configured files but refuses paths outside the repo/worktree", () => {
    const root = tempDir();
    const repoParent = join(root, "repos");
    const worktreeParent = join(root, "worktrees");
    const repo = join(repoParent, "repo");
    const worktree = join(worktreeParent, "repo.feature");
    mkdirSync(repo, { recursive: true });
    mkdirSync(worktree, { recursive: true });

    writeFileSync(join(repoParent, "secret"), "do not copy");
    writeFileSync(join(repo, "safe.txt"), "copy me");
    writeFileSync(join(repo, ".hatchet.jsonc"), JSON.stringify({
      additionalFilesToCopy: ["safe.txt", "../secret"],
    }));

    const copied = copyWorktreeFiles(repo, worktree);

    expect(copied).toContain("safe.txt");
    expect(copied).not.toContain("../secret");
    expect(existsSync(join(worktree, "safe.txt"))).toBe(true);
    expect(existsSync(join(worktreeParent, "secret"))).toBe(false);
  });

  test("runs setup commands from project config", () => {
    const root = tempDir();
    const repo = join(root, "repo");
    const worktree = join(root, "repo.feature");
    mkdirSync(repo, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, ".hatchet.jsonc"), JSON.stringify({
      setupCommands: ["printf ready > setup.txt"],
    }));

    const result = runPostWorktreeHooks(repo, worktree);

    expect(result.success).toBe(true);
    expect(result.commandsRun).toEqual(["printf ready > setup.txt"]);
    expect(existsSync(join(worktree, "setup.txt"))).toBe(true);
  });
});
