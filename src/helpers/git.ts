import { execSync, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { Worktree } from "../types";

let cachedRepoRoot: string | null = null;
let cachedWorktrees: Worktree[] | null = null;

export function clearCache(): void {
  cachedRepoRoot = null;
  cachedWorktrees = null;
}

export function inGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function repoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  try {
    // Get the common dir (works for worktrees too)
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Resolve to absolute path and get parent
    const gitDir = path.resolve(commonDir);
    cachedRepoRoot = path.dirname(gitDir);
    return cachedRepoRoot;
  } catch {
    return process.cwd();
  }
}

export function repoName(): string {
  return path.basename(repoRoot());
}

export function worktrees(): Worktree[] {
  if (cachedWorktrees) return cachedWorktrees;

  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf-8",
      cwd: repoRoot(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result: Worktree[] = [];
    let current: Partial<Worktree> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          result.push(current as Worktree);
        }
        current = { path: line.slice(9) };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        // Extract just the branch name from refs/heads/...
        const ref = line.slice(7);
        current.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        current.isBare = true;
      } else if (line === "" && current.path) {
        result.push(current as Worktree);
        current = {};
      }
    }

    if (current.path) {
      result.push(current as Worktree);
    }

    // Filter out bare repos and ensure branch exists
    cachedWorktrees = result
      .filter((wt) => !wt.isBare && wt.branch)
      .map((wt) => ({
        branch: wt.branch!,
        path: wt.path!,
        head: wt.head,
      }));

    return cachedWorktrees;
  } catch {
    return [];
  }
}

export function worktreeExists(branch: string): boolean {
  return worktrees().some((wt) => wt.branch === branch);
}

export function worktreePath(branch: string): string | null {
  const wt = worktrees().find((w) => w.branch === branch);
  return wt?.path ?? null;
}

export function sanitizeBranch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_/.]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function createWorktree(branch: string): string {
  clearCache();

  const sanitized = sanitizeBranch(branch);
  const root = repoRoot();
  const name = repoName();
  const parentDir = path.dirname(root);
  // Convert slashes to dashes for folder name (e.g., feature/asdf -> feature-asdf)
  const folderSuffix = sanitized.replace(/\//g, "-");
  const worktreeDir = path.join(parentDir, `${name}.${folderSuffix}`);

  // Check if branch exists remotely
  let branchExists = false;
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${sanitized}`, {
      cwd: root,
      stdio: "pipe",
    });
    branchExists = true;
  } catch {
    try {
      execSync(`git show-ref --verify --quiet refs/remotes/origin/${sanitized}`, {
        cwd: root,
        stdio: "pipe",
      });
      branchExists = true;
    } catch {
      // Branch doesn't exist
    }
  }

  if (branchExists) {
    execSync(`git worktree add "${worktreeDir}" "${sanitized}"`, {
      cwd: root,
      stdio: "pipe",
    });
  } else {
    // Create new branch from current HEAD
    execSync(`git worktree add -b "${sanitized}" "${worktreeDir}"`, {
      cwd: root,
      stdio: "pipe",
    });
  }

  clearCache();
  return worktreeDir;
}

export function removeWorktree(branch: string, deleteBranch = false): void {
  clearCache();

  const wtPath = worktreePath(branch);
  if (!wtPath) return;

  try {
    execSync(`git worktree remove "${wtPath}" --force`, {
      cwd: repoRoot(),
      stdio: "pipe",
    });
  } catch (error) {
    // If git worktree remove fails (e.g., orphaned worktree with invalid .git file),
    // check if the worktree's .git points to a non-existent location
    const gitFilePath = path.join(wtPath, ".git");
    
    if (fs.existsSync(gitFilePath)) {
      try {
        const gitContent = fs.readFileSync(gitFilePath, "utf-8");
        const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m);
        
        if (gitdirMatch) {
          const gitdir = gitdirMatch[1].trim();
          
          // If the gitdir doesn't exist, this is an orphaned worktree
          if (!fs.existsSync(gitdir)) {
            // Remove the .git file so the directory is no longer seen as a worktree
            fs.unlinkSync(gitFilePath);
            // Prune to clean up git's worktree list
            try {
              execSync("git worktree prune", {
                cwd: repoRoot(),
                stdio: "pipe",
              });
            } catch {
              // Ignore prune errors
            }
          } else {
            // gitdir exists but removal still failed - rethrow
            throw error;
          }
        }
      } catch (readError) {
        // If we can't read/parse the .git file, rethrow original error
        if (readError === error) throw error;
        throw error;
      }
    } else {
      // No .git file, just prune
      try {
        execSync("git worktree prune", {
          cwd: repoRoot(),
          stdio: "pipe",
        });
      } catch {
        // Ignore prune errors
      }
    }
  }

  if (deleteBranch) {
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: repoRoot(),
        stdio: "pipe",
      });
    } catch {
      // Branch might not exist or might be checked out elsewhere
    }
  }

  clearCache();
}

export function defaultBranch(): string {
  try {
    // Try to get the default branch from remote
    const output = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output.replace("refs/remotes/origin/", "");
  } catch {
    // Fall back to common defaults
    try {
      execSync("git show-ref --verify --quiet refs/heads/main", {
        stdio: "pipe",
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
  relativeDate: string;
}

export interface BranchStatus {
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  lastCommit?: CommitInfo;
  recentCommits: CommitInfo[];
}

export function getBranchStatus(worktreePath: string): BranchStatus {
  const status: BranchStatus = {
    ahead: 0,
    behind: 0,
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    recentCommits: [],
  };

  try {
    // Get ahead/behind counts
    // Try multiple refs in order of preference
    const refsToTry = [
      "@{upstream}",           // Configured upstream
      "origin/main",           // Remote main
      "origin/master",         // Remote master
      "main",                  // Local main
      "master",                // Local master
    ];
    
    for (const ref of refsToTry) {
      try {
        const revList = execSync(`git rev-list --left-right --count ${ref}...HEAD`, {
          encoding: "utf-8",
          cwd: worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const [behind, ahead] = revList.split(/\s+/).map(Number);
        status.behind = behind || 0;
        status.ahead = ahead || 0;
        break; // Successfully got counts, stop trying
      } catch {
        // This ref doesn't exist or isn't valid, try next
        continue;
      }
    }

    // Get working tree status
    const statusOutput = execSync("git status --porcelain", {
      encoding: "utf-8",
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    for (const line of statusOutput.split("\n")) {
      if (!line) continue;
      const index = line[0];
      const working = line[1];
      
      if (line.startsWith("??")) {
        status.untracked++;
      } else {
        if (index !== " " && index !== "?") {
          status.staged++;
        }
        if (working !== " " && working !== "?") {
          status.unstaged++;
        }
      }
    }

    status.dirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;

    // Get recent commits (up to 5)
    try {
      const logOutput = execSync(
        'git log -5 --format="%H|%s|%an|%ai|%ar"',
        {
          encoding: "utf-8",
          cwd: worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
        }
      ).trim();

      for (const line of logOutput.split("\n")) {
        if (!line) continue;
        const [hash, message, author, date, relativeDate] = line.split("|");
        const commit: CommitInfo = {
          hash: hash.slice(0, 7),
          message: message.length > 50 ? message.slice(0, 47) + "..." : message,
          author,
          date,
          relativeDate,
        };
        status.recentCommits.push(commit);
      }
      
      // First commit is the most recent
      if (status.recentCommits.length > 0) {
        status.lastCommit = status.recentCommits[0];
      }
    } catch {
      // No commits yet
    }

    return status;
  } catch {
    return status;
  }
}
