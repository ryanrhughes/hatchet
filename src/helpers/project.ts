/**
 * Project detection and post-worktree hooks
 * 
 * Detects project types (Rails, Node, etc.) and runs appropriate
 * setup after creating a worktree.
 */

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { hasSqliteDatabases, cloneDatabases, getDatabaseSummary } from "./database";
import { loadConfig, type HatchetConfig } from "./config";

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
  /** Setup commands that were run after worktree creation */
  commandsRun?: string[];
}

/**
 * Run post-worktree-creation hooks for the project
 */
export function runPostWorktreeHooks(
  repoRoot: string,
  worktreePath: string
): PostWorktreeResult {
  const projectInfo = detectProjectType(repoRoot);
  const config = loadConfig(repoRoot);
  const results: PostWorktreeResult[] = [];
  
  // For Rails projects with SQLite databases, clone them directly
  // (unless skipDatabaseCopy is enabled in config)
  if (projectInfo.type === "rails" && projectInfo.hasDatabases) {
    if (config.skipDatabaseCopy) {
      results.push({
        success: true,
        message: "Database copying skipped (disabled in config)",
      });
    } else {
      results.push(cloneSqliteDatabases(repoRoot, worktreePath));
    }
  } else {
    results.push({
      success: true,
      message: `No databases to clone for ${projectInfo.type} project`,
    });
  }

  const setupResult = runSetupCommands(worktreePath, config);
  if (setupResult) {
    results.push(setupResult);
  }

  return combinePostWorktreeResults(results);
}

/**
 * Clone SQLite databases directly (no rake task needed)
 */
function getSetupCommands(config: HatchetConfig): string[] {
  return config.setupCommands ?? config.setup ?? [];
}

function runSetupCommands(worktreePath: string, config: HatchetConfig): PostWorktreeResult | null {
  const commands = getSetupCommands(config).filter(command => command.trim().length > 0);
  if (commands.length === 0) return null;

  const details: string[] = [];
  const shell = process.env.SHELL || "/bin/bash";

  for (const command of commands) {
    details.push(`$ ${command}`);
    try {
      const output = execSync(command, {
        cwd: worktreePath,
        encoding: "utf-8",
        shell,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (output.trim()) details.push(output.trim());
    } catch (error) {
      const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const stdout = Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf-8") : err.stdout;
      const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf-8") : err.stderr;
      const message = (stderr || stdout || err.message || "Setup command failed").trim();
      details.push(message);
      return {
        success: false,
        message: `Setup failed: ${command}`,
        details: details.join("\n"),
        commandsRun: commands,
      };
    }
  }

  return {
    success: true,
    message: `${commands.length} setup command(s) completed`,
    details: details.join("\n"),
    commandsRun: commands,
  };
}

function combinePostWorktreeResults(results: PostWorktreeResult[]): PostWorktreeResult {
  const success = results.every(result => result.success);
  const messages = results.map(result => result.message).filter(Boolean);
  const details = results.map(result => result.details).filter(Boolean).join("\n");
  const commandsRun = results.flatMap(result => result.commandsRun ?? []);

  return {
    success,
    message: messages.join("; "),
    details: details || undefined,
    dbFilesCopied: results.reduce((sum, result) => sum + (result.dbFilesCopied ?? 0), 0),
    filesCopied: results.reduce((sum, result) => sum + (result.filesCopied ?? 0), 0),
    commandsRun: commandsRun.length > 0 ? commandsRun : undefined,
  };
}

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
  const config = loadConfig(repoRoot);
  
  // Skip if disabled in config
  if (config.skipEnvCopy) {
    return [];
  }
  
  const copied: string[] = [];
  
  // Files to copy if they exist (and are gitignored)
  const filesToCopy = [
    ".env",
    ".env.local",
    ".env.development.local",
    "config/master.key",
    "config/credentials/development.key",
    // Add any additional files from config
    ...(config.additionalFilesToCopy ?? []),
  ];
  
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedWorktreePath = path.resolve(worktreePath);

  for (const file of filesToCopy) {
    const normalizedFile = file.replace(/^\/+/, "");
    const src = path.resolve(resolvedRepoRoot, normalizedFile);
    const dst = path.resolve(resolvedWorktreePath, normalizedFile);

    // Never let config escape the repository or target worktree.
    if (!src.startsWith(`${resolvedRepoRoot}${path.sep}`) || !dst.startsWith(`${resolvedWorktreePath}${path.sep}`)) {
      continue;
    }
    
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        // Ensure directory exists
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied.push(normalizedFile);
      } catch {
        // Ignore copy errors
      }
    }
  }
  
  return copied;
}
