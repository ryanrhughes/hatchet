import { execFileSync, execSync, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { Worktree } from "../types";
import { 
  detectProjectType, 
  runPostWorktreeHooks, 
  copyWorktreeFiles,
  type PostWorktreeResult,
  type ProjectInfo,
} from "./project";

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

/**
 * Check if a worktree is the main repository (not a created worktree).
 * The main repository's path equals the repo root.
 */
export function isMainWorktree(worktreePath: string): boolean {
  return worktreePath === repoRoot();
}

export function sanitizeBranch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_/.]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export interface CreateWorktreeResult {
  path: string;
  branch: string;
  projectInfo: ProjectInfo;
  postHooks: PostWorktreeResult;
  copiedFiles: string[];
}

export interface CreateWorktreeOptions {
  /** PR number to include in folder name (e.g., repo.pr-123-branch-name) */
  prNumber?: number;
}

export type PRReviewMergeStatus = "clean" | "conflicts";

export interface CreatePRReviewWorktreeOptions {
  /** Base branch name from the PR, e.g. master or main */
  baseRef: string;
  /** PR title, used only in generated review notes */
  title?: string;
  /** Recreate the disposable review worktree if it already exists (default: true) */
  recreateExisting?: boolean;
}

export interface PRReviewWorktreeResult {
  path: string;
  branch: string;
  prRef: string;
  baseRef: string;
  baseRemoteRef: string;
  mergeBase: string;
  baseSha: string;
  prSha: string;
  resultSha?: string;
  mergeStatus: PRReviewMergeStatus;
  conflictFiles: string[];
  baseAdvancedCommitCount: number;
  prCommitCount: number;
  baseChangedFiles: string[];
  prChangedFiles: string[];
  overlappingFiles: string[];
  projectInfo: ProjectInfo;
  postHooks: PostWorktreeResult;
  copiedFiles: string[];
  reviewMarkdownPath: string;
  reviewMarkdown: string;
}

function gitErrorMessage(args: string[], error: unknown): string {
  const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : err.stderr;
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : err.stdout;
  const details = (stderr || stdout || err.message || "Unknown git error").trim();
  return `git ${args.join(" ")} failed: ${details}`;
}

function gitOutput(args: string[], cwd = repoRoot()): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(gitErrorMessage(args, error));
  }
}

function gitRun(args: string[], cwd = repoRoot()): void {
  try {
    execFileSync("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(gitErrorMessage(args, error));
  }
}

function gitLines(args: string[], cwd = repoRoot()): string[] {
  const output = gitOutput(args, cwd);
  return output ? output.split("\n").filter(Boolean) : [];
}

function markdownList(items: string[], empty = "_None_"): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- \`${item}\``).join("\n");
}

function ensureWorktreeExclude(worktreeDir: string, pattern: string): void {
  try {
    const excludePath = gitOutput(["rev-parse", "--git-path", "info/exclude"], worktreeDir);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
    const lines = existing.split("\n").map((line) => line.trim());
    if (!lines.includes(pattern)) {
      fs.appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${pattern}\n`);
    }
  } catch {
    // Review notes are useful but should never prevent worktree creation.
  }
}

export function reviewBranchName(prNumber: number): string {
  return `hatchet/review-pr-${prNumber}`;
}

export function reviewWorktreePath(prNumber: number): string {
  const root = repoRoot();
  const parentDir = path.dirname(root);
  return path.join(parentDir, `${repoName()}.review-pr-${prNumber}`);
}

export function isReviewBranch(branch: string): boolean {
  return /^hatchet\/review-pr-\d+$/.test(branch);
}

export function parseReviewPRFromBranch(branch: string): number | null {
  const match = branch.match(/^hatchet\/review-pr-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function prBranchName(prNumber: number): string {
  return `hatchet/pr-${prNumber}`;
}

export function parsePRFromBranch(branch: string): number | null {
  const match = branch.match(/^hatchet\/pr-(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function prWorktreePath(prNumber: number, headRef?: string): string {
  const root = repoRoot();
  const parentDir = path.dirname(root);
  const suffix = headRef ? sanitizeBranch(headRef).replace(/\//g, "-") : `pr-${prNumber}`;
  return path.join(parentDir, `${repoName()}.pr-${prNumber}-${suffix || `pr-${prNumber}`}`);
}

function buildPRReviewMarkdown(prNumber: number, result: Omit<PRReviewWorktreeResult, "reviewMarkdown" | "reviewMarkdownPath" | "projectInfo" | "postHooks" | "copiedFiles">, title?: string): string {
  const lines: string[] = [];
  const mergeLabel = result.mergeStatus === "clean" ? "Clean merge" : "Merge conflicts";

  lines.push(`# PR #${prNumber} Review Worktree`);
  if (title) lines.push(`\n${title}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Merge result");
  lines.push("");
  lines.push(`- Status: **${mergeLabel}**`);
  lines.push(`- Base: \`${result.baseRemoteRef}\` @ \`${result.baseSha}\``);
  lines.push(`- PR head: \`${result.prRef}\` @ \`${result.prSha}\``);
  if (result.resultSha) lines.push(`- Review HEAD: \`${result.resultSha}\``);
  lines.push(`- Merge base: \`${result.mergeBase.slice(0, 12)}\``);
  lines.push(`- Base advanced by: **${result.baseAdvancedCommitCount}** commit(s) since the PR fork point`);
  lines.push(`- PR commits since fork point: **${result.prCommitCount}**`);
  if (result.prCommitCount === 0) {
    lines.push("- Note: the PR head is already contained in the latest base; no PR-only commits remain to merge.");
  }
  lines.push("");

  if (result.mergeStatus === "conflicts") {
    lines.push("## Conflicts");
    lines.push("");
    lines.push(markdownList(result.conflictFiles));
    lines.push("");
  }

  lines.push("## Changed-file overlap");
  lines.push("");
  lines.push(`Overlap count: **${result.overlappingFiles.length}**`);
  lines.push("");
  lines.push(markdownList(result.overlappingFiles));
  lines.push("");

  lines.push("## Files changed on base since PR fork");
  lines.push("");
  lines.push(markdownList(result.baseChangedFiles));
  lines.push("");

  lines.push("## Files changed by PR since fork");
  lines.push("");
  lines.push(markdownList(result.prChangedFiles));
  lines.push("");

  lines.push("## Useful commands");
  lines.push("");
  lines.push("```bash");
  lines.push("git status");
  lines.push(`git diff --stat ${result.baseRemoteRef}..HEAD`);
  lines.push(`git diff --name-only ${result.baseRemoteRef}...${result.prRef}`);
  lines.push("```");
  lines.push("");
  lines.push("> This is a local Hatchet review worktree. It does not update or push the PR branch.");
  lines.push("");

  return lines.join("\n");
}

export function createPRReviewWorktree(prNumber: number, options: CreatePRReviewWorktreeOptions): PRReviewWorktreeResult {
  clearCache();

  const root = repoRoot();
  const branchName = reviewBranchName(prNumber);
  const worktreeDir = reviewWorktreePath(prNumber);
  const baseRef = options.baseRef || defaultBranch();
  const baseRemoteRef = `refs/remotes/origin/${baseRef}`;
  const prRef = `refs/hatchet/pr/${prNumber}`;
  const recreateExisting = options.recreateExisting ?? true;

  const existingPath = worktreePath(branchName);
  if (existingPath) {
    if (!recreateExisting) {
      throw new Error(`Review worktree already exists: ${existingPath}`);
    }
    gitRun(["worktree", "remove", "--force", existingPath], root);
    clearCache();
  }

  if (fs.existsSync(worktreeDir)) {
    if (!recreateExisting) {
      throw new Error(`Review worktree path already exists: ${worktreeDir}`);
    }
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }

  // Remove the old local synthetic branch if it exists and is not checked out.
  try {
    gitRun(["branch", "-D", branchName], root);
  } catch {
    // It may not exist yet, which is fine.
  }

  // Always review against the latest fetched base and the PR's current head.
  gitRun(["fetch", "origin", `${baseRef}:${baseRemoteRef}`], root);
  gitRun(["fetch", "origin", `+pull/${prNumber}/head:${prRef}`], root);

  const mergeBase = gitOutput(["merge-base", baseRemoteRef, prRef], root);
  const baseSha = gitOutput(["rev-parse", "--short", baseRemoteRef], root);
  const prSha = gitOutput(["rev-parse", "--short", prRef], root);
  const baseAdvancedCommitCount = Number(gitOutput(["rev-list", "--count", `${mergeBase}..${baseRemoteRef}`], root)) || 0;
  const prCommitCount = Number(gitOutput(["rev-list", "--count", `${mergeBase}..${prRef}`], root)) || 0;
  const baseChangedFiles = gitLines(["diff", "--name-only", `${mergeBase}..${baseRemoteRef}`], root);
  const prChangedFiles = gitLines(["diff", "--name-only", `${mergeBase}..${prRef}`], root);
  const baseChangedSet = new Set(baseChangedFiles);
  const overlappingFiles = prChangedFiles.filter((file) => baseChangedSet.has(file));

  gitRun(["worktree", "add", "-B", branchName, worktreeDir, baseRemoteRef], root);

  let mergeStatus: PRReviewMergeStatus = "clean";
  try {
    gitRun(["merge", "--no-ff", "--no-edit", prRef], worktreeDir);
  } catch {
    mergeStatus = "conflicts";
  }

  const conflictFiles = mergeStatus === "conflicts"
    ? gitLines(["diff", "--name-only", "--diff-filter=U"], worktreeDir)
    : [];
  const resultSha = mergeStatus === "clean"
    ? gitOutput(["rev-parse", "--short", "HEAD"], worktreeDir)
    : undefined;

  const projectInfo = detectProjectType(root);
  const copiedFiles = copyWorktreeFiles(root, worktreeDir);
  const postHooks = runPostWorktreeHooks(root, worktreeDir);

  const resultForMarkdown = {
    path: worktreeDir,
    branch: branchName,
    prRef,
    baseRef,
    baseRemoteRef,
    mergeBase,
    baseSha,
    prSha,
    resultSha,
    mergeStatus,
    conflictFiles,
    baseAdvancedCommitCount,
    prCommitCount,
    baseChangedFiles,
    prChangedFiles,
    overlappingFiles,
  };
  const reviewMarkdown = buildPRReviewMarkdown(prNumber, resultForMarkdown, options.title);
  const reviewDir = path.join(worktreeDir, ".hatchet");
  fs.mkdirSync(reviewDir, { recursive: true });
  const reviewMarkdownPath = path.join(reviewDir, "review.md");
  fs.writeFileSync(reviewMarkdownPath, reviewMarkdown);
  ensureWorktreeExclude(worktreeDir, ".hatchet/");

  clearCache();

  return {
    ...resultForMarkdown,
    projectInfo,
    postHooks,
    copiedFiles,
    reviewMarkdownPath,
    reviewMarkdown,
  };
}

export function createPRWorktree(prNumber: number, options?: { headRef?: string }): CreateWorktreeResult {
  clearCache();

  const root = repoRoot();
  const branchName = prBranchName(prNumber);
  const worktreeDir = prWorktreePath(prNumber, options?.headRef);
  const prRef = `refs/hatchet/pr/${prNumber}`;

  const existingPath = worktreePath(branchName);
  if (existingPath) {
    throw new Error(`PR worktree already exists: ${existingPath}`);
  }

  if (fs.existsSync(worktreeDir)) {
    throw new Error(`PR worktree path already exists: ${worktreeDir}`);
  }

  // Fetch through GitHub's pull ref so PRs from forks work too.
  gitRun(["fetch", "origin", `+pull/${prNumber}/head:${prRef}`], root);

  // This branch namespace is owned by Hatchet, so an unchecked-out stale branch can be replaced.
  try {
    gitRun(["branch", "-D", branchName], root);
  } catch {
    // It may not exist yet, which is fine.
  }

  gitRun(["worktree", "add", "-b", branchName, worktreeDir, prRef], root);

  clearCache();

  const projectInfo = detectProjectType(root);
  const copiedFiles = copyWorktreeFiles(root, worktreeDir);
  const postHooks = runPostWorktreeHooks(root, worktreeDir);

  return {
    path: worktreeDir,
    branch: branchName,
    projectInfo,
    postHooks,
    copiedFiles,
  };
}

export function createWorktree(branch: string, options?: CreateWorktreeOptions): CreateWorktreeResult {
  clearCache();

  const sanitized = sanitizeBranch(branch);
  const root = repoRoot();
  const name = repoName();
  const parentDir = path.dirname(root);
  // Convert slashes to dashes for folder name (e.g., feature/asdf -> feature-asdf)
  const folderSuffix = sanitized.replace(/\//g, "-");
  // Include PR number in folder name if provided (e.g., repo.pr-123-branch-name)
  const folderName = options?.prNumber 
    ? `${name}.pr-${options.prNumber}-${folderSuffix}`
    : `${name}.${folderSuffix}`;
  const worktreeDir = path.join(parentDir, folderName);

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

  // Detect project type and run post-worktree hooks
  const projectInfo = detectProjectType(root);
  
  // Copy shared files (env, keys, etc.)
  const copiedFiles = copyWorktreeFiles(root, worktreeDir);
  
  // Run project-specific hooks (e.g., database cloning for Rails)
  const postHooks = runPostWorktreeHooks(root, worktreeDir);

  return {
    path: worktreeDir,
    branch: sanitized,
    projectInfo,
    postHooks,
    copiedFiles,
  };
}

/** Simple version that just returns the path (for backward compatibility) */
export function createWorktreeSimple(branch: string): string {
  return createWorktree(branch).path;
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

/**
 * Fetch a specific branch from origin.
 * Useful for PR branches that may not be locally available yet.
 */
export function fetchBranch(branch: string): boolean {
  try {
    execSync(`git fetch origin ${branch}`, {
      cwd: repoRoot(),
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a branch exists locally or remotely
 */
export function branchExists(branch: string): boolean {
  const sanitized = sanitizeBranch(branch);
  const root = repoRoot();
  
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${sanitized}`, {
      cwd: root,
      stdio: "pipe",
    });
    return true;
  } catch {
    try {
      execSync(`git show-ref --verify --quiet refs/remotes/origin/${sanitized}`, {
        cwd: root,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }
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
