/**
 * Project detection and post-worktree hooks
 * 
 * Detects project types (Rails, Node, etc.) and runs appropriate
 * setup after creating a worktree.
 */

import * as path from "path";
import * as fs from "fs";
import { hasSqliteDatabases, cloneDatabases, getDatabaseSummary } from "./database";

export type ProjectType = "rails" | "node" | "bun" | "unknown";

export interface ProjectInfo {
  type: ProjectType;
  /** Has SQLite databases that can be cloned */
  hasDatabases: boolean;
}

/**
 * Detect the project type from the repository root
 */
export function detectProjectType(repoRoot: string): ProjectInfo {
  // Check for Rails
  const gemfile = path.join(repoRoot, "Gemfile");
  const binRails = path.join(repoRoot, "bin", "rails");
  
  if (fs.existsSync(gemfile) && fs.existsSync(binRails)) {
    // It's a Rails project - check for SQLite databases
    const hasDbs = hasSqliteDatabases(repoRoot);
    
    return {
      type: "rails",
      hasDatabases: hasDbs,
    };
  }
  
  // Check for Bun
  const bunLock = path.join(repoRoot, "bun.lock");
  const bunLockb = path.join(repoRoot, "bun.lockb");
  if (fs.existsSync(bunLock) || fs.existsSync(bunLockb)) {
    return {
      type: "bun",
      hasDatabases: false,
    };
  }
  
  // Check for Node
  const packageJson = path.join(repoRoot, "package.json");
  if (fs.existsSync(packageJson)) {
    return {
      type: "node",
      hasDatabases: false,
    };
  }
  
  return {
    type: "unknown",
    hasDatabases: false,
  };
}

export interface PostWorktreeResult {
  success: boolean;
  message: string;
  details?: string;
  /** Number of database files copied */
  dbFilesCopied?: number;
  /** Number of other files copied */
  filesCopied?: number;
}

/**
 * Run post-worktree-creation hooks for the project
 */
export function runPostWorktreeHooks(
  repoRoot: string,
  worktreePath: string
): PostWorktreeResult {
  const projectInfo = detectProjectType(repoRoot);
  
  // For Rails projects with SQLite databases, clone them directly
  if (projectInfo.type === "rails" && projectInfo.hasDatabases) {
    return cloneSqliteDatabases(repoRoot, worktreePath);
  }
  
  return {
    success: true,
    message: `No databases to clone for ${projectInfo.type} project`,
  };
}

/**
 * Clone SQLite databases directly (no rake task needed)
 */
function cloneSqliteDatabases(
  repoRoot: string,
  worktreePath: string
): PostWorktreeResult {
  const result = cloneDatabases(repoRoot, worktreePath, "development");
  
  if (result.copied.length === 0) {
    return {
      success: true,
      message: "No database files to copy",
      details: result.skipped.join(", "),
    };
  }
  
  if (result.errors.length > 0) {
    return {
      success: false,
      message: `Copied ${result.copied.length} databases with ${result.errors.length} errors`,
      details: result.errors.join("\n"),
      dbFilesCopied: result.copied.length,
    };
  }
  
  // Build a nice summary
  const totalSize = result.copied.reduce((sum, f) => sum + f.size, 0);
  const tenantCount = result.copied.filter(f => f.isTenant).length;
  const regularCount = result.copied.length - tenantCount;
  
  let summary = `${result.copied.length} database(s) copied`;
  if (tenantCount > 0) {
    summary = `${regularCount} database(s) + ${tenantCount} tenant(s) copied`;
  }
  
  return {
    success: true,
    message: summary,
    details: result.copied.map(f => `  ${f.relativePath} (${f.humanSize})`).join("\n"),
    dbFilesCopied: result.copied.length,
  };
}

/**
 * Get a preview of what databases would be cloned
 */
export function previewDatabaseClone(repoRoot: string): string | null {
  const projectInfo = detectProjectType(repoRoot);
  
  if (projectInfo.type !== "rails" || !projectInfo.hasDatabases) {
    return null;
  }
  
  return getDatabaseSummary(repoRoot, "development");
}

/**
 * Copy additional files that should be shared between worktrees
 */
export function copyWorktreeFiles(
  repoRoot: string,
  worktreePath: string
): string[] {
  const copied: string[] = [];
  
  // Files to copy if they exist (and are gitignored)
  const filesToCopy = [
    ".env.local",
    ".env.development.local",
    "config/master.key",
    "config/credentials/development.key",
  ];
  
  for (const file of filesToCopy) {
    const src = path.join(repoRoot, file);
    const dst = path.join(worktreePath, file);
    
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        // Ensure directory exists
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(file);
      } catch {
        // Ignore copy errors
      }
    }
  }
  
  return copied;
}
