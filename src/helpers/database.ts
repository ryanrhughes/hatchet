/**
 * Database detection and cloning for Rails projects
 * 
 * This module parses database.yml directly and clones SQLite databases
 * without requiring any rake tasks or Rails environment.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

export interface DatabaseConfig {
  name: string;
  adapter: string;
  database: string;
  tenanted: boolean;
  host?: string;
  port?: number;
  migrationsPath?: string;
}

export interface CloneOptions {
  /** 
   * Database names to symlink instead of copy.
   * Useful for sharing session state across worktrees.
   * Default: [] (copy everything)
   */
  symlink?: string[];
  
  /**
   * Database names to skip entirely (don't copy or symlink).
   * Useful for caches that will be regenerated.
   * Default: []
   */
  skip?: string[];
}

export interface DatabaseFile {
  /** Relative path from project root */
  relativePath: string;
  /** Absolute path */
  absolutePath: string;
  /** Size in bytes */
  size: number;
  /** Human-readable size */
  humanSize: string;
  /** Database config name (e.g., "primary", "global") */
  configName: string;
  /** Is this a tenant database? */
  isTenant: boolean;
  /** Tenant ID if applicable */
  tenantId?: string;
}

export interface DatabaseCloneResult {
  success: boolean;
  copied: DatabaseFile[];
  skipped: string[];
  errors: string[];
}

/**
 * Parse database.yml and extract database configurations for an environment
 */
export function parseDatabaseConfig(
  projectRoot: string,
  environment: string = "development"
): DatabaseConfig[] {
  const configPath = path.join(projectRoot, "config", "database.yml");
  
  if (!fs.existsSync(configPath)) {
    return [];
  }
  
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    
    // Handle ERB-style interpolations by replacing with placeholders
    // We handle common patterns:
    // - <%= ENV.fetch("VAR", "default") %> -> default
    // - <%= ENV.fetch("VAR") { default } %> -> default (block syntax)
    // - <%= ENV["VAR"] || "default" %> -> default
    // - <%= Rails.env %> -> environment
    // - %{tenant} -> kept as-is (it's a pattern, not ERB)
    const processedContent = content
      // ENV.fetch with block default: ENV.fetch("VAR") { 5 }
      .replace(/<%=\s*ENV\.fetch\s*\(\s*["'][^"']+["']\s*\)\s*\{\s*([^}]+)\s*\}\s*%>/g, "$1")
      // ENV.fetch with second arg default: ENV.fetch("VAR", "default")
      .replace(/<%=\s*ENV\.fetch\s*\(\s*["'][^"']+["']\s*,\s*["']?([^"'<>)]+)["']?\s*\)\s*%>/g, "$1")
      // ENV.fetch without default (use empty string)
      .replace(/<%=\s*ENV\.fetch\s*\(\s*["'][^"']+["']\s*\)\s*%>/g, "")
      // ENV[] with || default
      .replace(/<%=\s*ENV\s*\[\s*["'][^"']+["']\s*\]\s*\|\|\s*["']?([^"'<>]+)["']?\s*%>/g, "$1")
      // ENV[] without default
      .replace(/<%=\s*ENV\s*\[\s*["'][^"']+["']\s*\]\s*%>/g, "")
      // Rails.env
      .replace(/<%=\s*Rails\.env\s*%>/g, environment)
      // Any remaining ERB tags (strip them)
      .replace(/<%[^%]*%>/g, "");
    
    // Parse YAML with merge key support
    const parsed = yaml.parse(processedContent, { merge: true });
    
    if (!parsed || !parsed[environment]) {
      return [];
    }
    
    const envConfig = parsed[environment];
    const configs: DatabaseConfig[] = [];
    
    // Handle both single database and multi-database configs
    if (envConfig.adapter) {
      // Single database config
      configs.push({
        name: "primary",
        adapter: envConfig.adapter,
        database: envConfig.database,
        tenanted: envConfig.tenanted === true,
        host: envConfig.host,
        port: envConfig.port,
        migrationsPath: envConfig.migrations_paths,
      });
    } else {
      // Multi-database config (Rails 6+)
      for (const [name, dbConfig] of Object.entries(envConfig)) {
        if (typeof dbConfig === "object" && dbConfig !== null) {
          const config = dbConfig as Record<string, unknown>;
          // Check for adapter - might be directly on config or merged from <<
          const adapter = config.adapter as string | undefined;
          if (adapter) {
            configs.push({
              name,
              adapter,
              database: config.database as string,
              tenanted: config.tenanted === true,
              host: config.host as string | undefined,
              port: config.port as number | undefined,
              migrationsPath: config.migrations_paths as string | undefined,
            });
          }
        }
      }
    }
    
    return configs;
  } catch (error) {
    console.error("Error parsing database.yml:", error);
    return [];
  }
}

/**
 * Find all SQLite database files for the given configs
 */
export function findDatabaseFiles(
  projectRoot: string,
  configs: DatabaseConfig[]
): DatabaseFile[] {
  const files: DatabaseFile[] = [];
  
  for (const config of configs) {
    if (config.adapter !== "sqlite3") {
      continue;
    }
    
    if (config.tenanted) {
      // Tenanted database - find all tenant directories
      // Pattern: storage/tenants/development/%{tenant}/main.sqlite3
      const pattern = config.database;
      const parts = pattern.split("%{tenant}");
      
      if (parts.length === 2) {
        const baseDir = path.join(projectRoot, parts[0]);
        const suffix = parts[1];
        
        if (fs.existsSync(baseDir)) {
          try {
            const tenantDirs = fs.readdirSync(baseDir, { withFileTypes: true });
            
            for (const dirent of tenantDirs) {
              if (dirent.isDirectory()) {
                const tenantId = dirent.name;
                const dbPath = path.join(baseDir, tenantId, suffix.replace(/^\//, ""));
                
                if (fs.existsSync(dbPath)) {
                  const stats = fs.statSync(dbPath);
                  const relativePath = path.relative(projectRoot, dbPath);
                  
                  files.push({
                    relativePath,
                    absolutePath: dbPath,
                    size: stats.size,
                    humanSize: humanFileSize(stats.size),
                    configName: config.name,
                    isTenant: true,
                    tenantId,
                  });
                }
              }
            }
          } catch {
            // Ignore errors reading tenant directories
          }
        }
      }
    } else {
      // Regular database file
      const dbPath = path.join(projectRoot, config.database);
      
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        const relativePath = path.relative(projectRoot, dbPath);
        
        files.push({
          relativePath,
          absolutePath: dbPath,
          size: stats.size,
          humanSize: humanFileSize(stats.size),
          configName: config.name,
          isTenant: false,
        });
      }
    }
  }
  
  return files;
}

/**
 * Clone all SQLite databases from source to target directory
 */
export function cloneDatabases(
  sourceRoot: string,
  targetRoot: string,
  environment: string = "development"
): DatabaseCloneResult {
  const result: DatabaseCloneResult = {
    success: true,
    copied: [],
    skipped: [],
    errors: [],
  };
  
  // Parse database config
  const configs = parseDatabaseConfig(sourceRoot, environment);
  
  if (configs.length === 0) {
    result.skipped.push("No database.yml found or no databases configured");
    return result;
  }
  
  // Find all database files
  const dbFiles = findDatabaseFiles(sourceRoot, configs);
  
  if (dbFiles.length === 0) {
    result.skipped.push("No SQLite database files found");
    return result;
  }
  
  // Copy each database file (and associated WAL/SHM files)
  for (const dbFile of dbFiles) {
    try {
      const targetPath = path.join(targetRoot, dbFile.relativePath);
      
      // Ensure target directory exists
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      
      // Copy main database file
      fs.copyFileSync(dbFile.absolutePath, targetPath);
      
      // Copy WAL file if exists
      const walPath = `${dbFile.absolutePath}-wal`;
      if (fs.existsSync(walPath)) {
        fs.copyFileSync(walPath, `${targetPath}-wal`);
      }
      
      // Copy SHM file if exists
      const shmPath = `${dbFile.absolutePath}-shm`;
      if (fs.existsSync(shmPath)) {
        fs.copyFileSync(shmPath, `${targetPath}-shm`);
      }
      
      result.copied.push(dbFile);
    } catch (error) {
      result.success = false;
      result.errors.push(`Failed to copy ${dbFile.relativePath}: ${error}`);
    }
  }
  
  return result;
}

/**
 * Get a summary of databases that would be cloned (dry run)
 */
export function getDatabaseSummary(
  projectRoot: string,
  environment: string = "development"
): string {
  const configs = parseDatabaseConfig(projectRoot, environment);
  
  if (configs.length === 0) {
    return "No databases configured in database.yml";
  }
  
  const lines: string[] = [];
  lines.push(`Databases for ${environment}:`);
  lines.push("");
  
  const dbFiles = findDatabaseFiles(projectRoot, configs);
  
  // Group by config name
  const byConfig = new Map<string, DatabaseFile[]>();
  for (const file of dbFiles) {
    const existing = byConfig.get(file.configName) || [];
    existing.push(file);
    byConfig.set(file.configName, existing);
  }
  
  // Show each config
  for (const config of configs) {
    lines.push(`  ${config.name}:`);
    lines.push(`    Adapter: ${config.adapter}`);
    
    if (config.adapter === "sqlite3") {
      const files = byConfig.get(config.name) || [];
      
      if (config.tenanted) {
        lines.push(`    Pattern: ${config.database}`);
        lines.push(`    Tenants: ${files.length}`);
        
        for (const file of files) {
          lines.push(`      - ${file.tenantId} (${file.humanSize})`);
        }
      } else {
        if (files.length > 0) {
          lines.push(`    Path: ${files[0].relativePath}`);
          lines.push(`    Size: ${files[0].humanSize}`);
        } else {
          lines.push(`    Path: ${config.database}`);
          lines.push(`    Status: not created yet`);
        }
      }
    } else {
      lines.push(`    Database: ${config.database}`);
      if (config.host) {
        lines.push(`    Host: ${config.host}`);
      }
      lines.push(`    Note: Non-SQLite, will not be cloned`);
    }
    
    lines.push("");
  }
  
  // Summary
  const totalSize = dbFiles.reduce((sum, f) => sum + f.size, 0);
  lines.push(`Total: ${dbFiles.length} file(s), ${humanFileSize(totalSize)}`);
  
  return lines.join("\n");
}

/**
 * Check if a project has SQLite databases that can be cloned
 */
export function hasSqliteDatabases(projectRoot: string): boolean {
  const configs = parseDatabaseConfig(projectRoot, "development");
  return configs.some(c => c.adapter === "sqlite3");
}

/**
 * Format bytes as human-readable string
 */
function humanFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let size = bytes;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
