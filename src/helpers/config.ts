/**
 * Configuration file loading for Hatchet
 * 
 * Looks for config in:
 * 1. .hatchet.jsonc in the project folder (repo root)
 * 2. ~/.config/hatchet/config.jsonc (global config)
 * 
 * Project config takes precedence over global config.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface HatchetConfig {
  /** Skip copying SQLite databases when creating worktrees */
  skipDatabaseCopy?: boolean;
  /** Skip copying environment files (.env.local, master.key, etc.) when creating worktrees */
  skipEnvCopy?: boolean;
  /** Default model to use when launching OpenCode (format: provider/model, e.g., "anthropic/claude-sonnet-4-20250514") */
  opencodeModel?: string;
  /** Additional files to copy when creating worktrees (relative to repo root) */
  additionalFilesToCopy?: string[];
}

const DEFAULT_CONFIG: HatchetConfig = {
  skipDatabaseCopy: false,
  skipEnvCopy: false,
};

let cachedConfig: HatchetConfig | null = null;
let cachedRepoRoot: string | null = null;

/**
 * Clear the config cache (useful when repo root changes)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedRepoRoot = null;
}

/**
 * Strip JSONC comments from a string
 * Handles both single-line and block comments
 */
function stripJsonComments(jsonc: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < jsonc.length) {
    const char = jsonc[i];
    const nextChar = jsonc[i + 1];

    // Handle string boundaries
    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
      result += char;
      i++;
      continue;
    }

    if (inString) {
      // Check for escape sequence
      if (char === "\\" && i + 1 < jsonc.length) {
        result += char + nextChar;
        i += 2;
        continue;
      }
      // Check for end of string
      if (char === stringChar) {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    // Handle single-line comments (//)
    if (char === "/" && nextChar === "/") {
      // Skip until end of line
      while (i < jsonc.length && jsonc[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Handle block comments (/* */)
    if (char === "/" && nextChar === "*") {
      i += 2;
      // Skip until end of block comment
      while (i < jsonc.length - 1) {
        if (jsonc[i] === "*" && jsonc[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse a JSONC file (JSON with comments)
 */
function parseJsonc(content: string): unknown {
  const stripped = stripJsonComments(content);
  return JSON.parse(stripped);
}

/**
 * Load config from a file path
 */
function loadConfigFile(filePath: string): HatchetConfig | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseJsonc(content);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    return parsed as HatchetConfig;
  } catch {
    // Invalid JSON or file read error
    return null;
  }
}

/**
 * Get the global config file path
 */
function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".config", "hatchet", "config.jsonc");
}

/**
 * Get the project config file path
 */
function getProjectConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".hatchet.jsonc");
}

/**
 * Load and merge configuration from all sources
 * Project config takes precedence over global config
 */
export function loadConfig(repoRoot: string): HatchetConfig {
  // Return cached config if repo root hasn't changed
  if (cachedConfig && cachedRepoRoot === repoRoot) {
    return cachedConfig;
  }

  // Start with defaults
  let config: HatchetConfig = { ...DEFAULT_CONFIG };

  // Load global config first
  const globalConfig = loadConfigFile(getGlobalConfigPath());
  if (globalConfig) {
    config = { ...config, ...globalConfig };
  }

  // Load project config (overrides global)
  const projectConfig = loadConfigFile(getProjectConfigPath(repoRoot));
  if (projectConfig) {
    config = { ...config, ...projectConfig };
  }

  // Cache the result
  cachedConfig = config;
  cachedRepoRoot = repoRoot;

  return config;
}

/**
 * Get a specific config value
 */
export function getConfigValue<K extends keyof HatchetConfig>(
  repoRoot: string,
  key: K
): HatchetConfig[K] {
  const config = loadConfig(repoRoot);
  return config[key] ?? DEFAULT_CONFIG[key];
}
