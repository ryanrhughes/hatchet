import { execFileSync } from "child_process";
import type { GitHubPR } from "../types";

let lastError: string | null = null;

function errorMessage(error: unknown): string {
  const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : err.stderr;
  const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : err.stdout;
  return (stderr || stdout || err.message || String(error)).trim();
}

export function getLastError(): string | null {
  return lastError;
}

/**
 * Execute a gh CLI command and return parsed JSON response
 */
function ghCmd<T>(args: string[]): T {
  try {
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch (error) {
    const message = errorMessage(error);
    lastError = message;
    throw new Error(`GitHub CLI command failed: ${message}`);
  }
}

/**
 * Check if the gh CLI is authenticated
 */
export function isAuthenticated(): boolean {
  try {
    execFileSync("gh", ["auth", "status"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if current directory is a GitHub repository
 */
export function isGitHubRepo(): boolean {
  try {
    execFileSync("gh", ["repo", "view", "--json", "name"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

interface GhPRResponse {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  body: string;
  labels: { name: string }[];
  reviewDecision: string | null;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/**
 * Fetch list of pull requests
 */
export function fetchPRs(options?: { 
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
}): GitHubPR[] {
  const state = options?.state || "open";
  const limit = options?.limit || 30;
  
  try {
    lastError = null;
    const prs = ghCmd<GhPRResponse[]>([
      "pr", "list",
      "--state", state,
      "--limit", limit.toString(),
      "--json", "number,title,state,headRefName,headRefOid,baseRefName,author,createdAt,updatedAt,body,labels,reviewDecision,isDraft,additions,deletions,changedFiles",
    ]);
    
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state.toLowerCase() as "open" | "closed" | "merged",
      headRef: pr.headRefName,
      headSha: pr.headRefOid.slice(0, 7),
      baseRef: pr.baseRefName,
      author: pr.author.login,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      body: pr.body,
      labels: pr.labels.map(l => l.name),
      reviewDecision: pr.reviewDecision as GitHubPR["reviewDecision"],
      isDraft: pr.isDraft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch a single PR by number
 */
export function fetchPR(prNumber: number): GitHubPR | null {
  try {
    lastError = null;
    const pr = ghCmd<GhPRResponse>([
      "pr", "view", prNumber.toString(),
      "--json", "number,title,state,headRefName,headRefOid,baseRefName,author,createdAt,updatedAt,body,labels,reviewDecision,isDraft,additions,deletions,changedFiles",
    ]);
    
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state.toLowerCase() as "open" | "closed" | "merged",
      headRef: pr.headRefName,
      headSha: pr.headRefOid.slice(0, 7),
      baseRef: pr.baseRefName,
      author: pr.author.login,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      body: pr.body,
      labels: pr.labels.map(l => l.name),
      reviewDecision: pr.reviewDecision as GitHubPR["reviewDecision"],
      isDraft: pr.isDraft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    };
  } catch {
    return null;
  }
}

// Cache for PR details
const prDetailsCache: Map<number, GitHubPR> = new Map();

/**
 * Fetch PR details with caching
 */
export function fetchPRDetails(prNumber: number): GitHubPR | null {
  if (prDetailsCache.has(prNumber)) {
    return prDetailsCache.get(prNumber)!;
  }
  
  const pr = fetchPR(prNumber);
  if (pr) {
    prDetailsCache.set(prNumber, pr);
  }
  return pr;
}

/**
 * Clear the PR details cache
 */
export function clearPRCache(): void {
  prDetailsCache.clear();
}

/**
 * Get the branch name to use for a PR worktree.
 * Uses the PR's head ref (actual branch name).
 */
export function branchFromPR(pr: GitHubPR): string {
  return pr.headRef;
}

/**
 * Parse PR number from a branch name.
 * Note: This is a heuristic - PR branches don't have a standard naming convention.
 * Returns null if we can't determine a PR number.
 */
export function parsePRFromBranch(_branchName: string): number | null {
  // PR branches don't have a standard format like Fizzy cards
  // This would need to be looked up via the gh CLI
  return null;
}

/**
 * Generate an initial prompt for the AI harness with PR context
 */
export function generateInitialPrompt(pr: GitHubPR): string {
  const lines: string[] = [];

  lines.push("I'm reviewing a GitHub Pull Request. Here are the details for context:");
  lines.push("");
  lines.push(`## PR #${pr.number}: ${pr.title}`);
  lines.push("");
  lines.push(`**Author:** ${pr.author}`);
  lines.push(`**Branch:** ${pr.headRef} → ${pr.baseRef}`);
  lines.push(`**Status:** ${pr.state}${pr.isDraft ? " (Draft)" : ""}`);
  
  if (pr.reviewDecision) {
    const reviewStatus = pr.reviewDecision.replace(/_/g, " ").toLowerCase();
    lines.push(`**Review:** ${reviewStatus}`);
  }
  
  if (pr.additions !== undefined && pr.deletions !== undefined) {
    lines.push(`**Changes:** +${pr.additions} / -${pr.deletions} in ${pr.changedFiles} files`);
  }

  if (pr.labels && pr.labels.length > 0) {
    lines.push(`**Labels:** ${pr.labels.join(", ")}`);
  }

  lines.push("");

  if (pr.body) {
    lines.push("### Description");
    lines.push(pr.body);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Please acknowledge that you've received these PR details and wait for my instructions on how to proceed.");

  return lines.join("\n");
}

/**
 * Generate an AI prompt for a Hatchet PR review worktree.
 */
export function generateReviewPrompt(pr: GitHubPR, reviewMarkdown: string): string {
  const lines: string[] = [];

  lines.push("I'm reviewing a GitHub Pull Request in a Hatchet review worktree.");
  lines.push("This worktree locally merges the PR head onto the latest fetched base branch, so review the merge result rather than only the stale PR branch.");
  lines.push("");
  lines.push(`## PR #${pr.number}: ${pr.title}`);
  lines.push("");
  lines.push(`**Author:** ${pr.author}`);
  lines.push(`**Branch:** ${pr.headRef} → ${pr.baseRef}`);
  lines.push(`**Status:** ${pr.state}${pr.isDraft ? " (Draft)" : ""}`);

  if (pr.additions !== undefined && pr.deletions !== undefined) {
    lines.push(`**GitHub diff:** +${pr.additions} / -${pr.deletions} in ${pr.changedFiles} files`);
  }

  lines.push("");
  lines.push("## Hatchet review summary");
  lines.push("");
  lines.push(reviewMarkdown);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Please review the merged result for correctness, regressions, test coverage, and issues introduced by the base branch moving since the PR was opened.");

  return lines.join("\n");
}

/**
 * Get a human-readable relative time string
 */
export function getRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  return `${diffMonths}mo ago`;
}
