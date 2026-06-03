import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { PostWorktreeResult } from "./project";

export type WorktreeSource = "manual" | "fizzy-card" | "github-pr" | "github-pr-review";
export type SetupStatus = "not-run" | "success" | "failed";

export interface WorktreeMetadata {
  version: 1;
  source: WorktreeSource;
  repoName: string;
  repoRoot: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  card?: {
    number: number;
    title?: string;
  };
  pr?: {
    number: number;
    title?: string;
    headRef?: string;
    baseRef?: string;
    review?: boolean;
  };
  copiedFiles?: string[];
  setup?: {
    status: SetupStatus;
    message?: string;
    details?: string;
    commands?: string[];
  };
  launch?: {
    aiCommand?: string;
    devCommand?: string;
    editorCommand?: string;
  };
}

export type WorktreeMetadataInput = Omit<WorktreeMetadata, "version" | "createdAt" | "updatedAt"> & {
  createdAt?: string;
  updatedAt?: string;
};

export function metadataDir(worktreePath: string): string {
  return path.join(worktreePath, ".hatchet");
}

export function metadataPath(worktreePath: string): string {
  return path.join(metadataDir(worktreePath), "meta.json");
}

export function readWorktreeMetadata(worktreePath: string): WorktreeMetadata | null {
  const filePath = metadataPath(worktreePath);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorktreeMetadata;
  } catch {
    return null;
  }
}

function ensureMetadataExcluded(worktreePath: string): void {
  try {
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
    if (!existing.split("\n").map(line => line.trim()).includes(".hatchet/")) {
      fs.appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.hatchet/\n`);
    }
  } catch {
    // Metadata should never prevent worktree creation.
  }
}

export function writeWorktreeMetadata(worktreePath: string, input: WorktreeMetadataInput): WorktreeMetadata {
  const now = new Date().toISOString();
  const existing = readWorktreeMetadata(worktreePath);
  const metadata: WorktreeMetadata = {
    version: 1,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...input,
  };

  fs.mkdirSync(metadataDir(worktreePath), { recursive: true });
  fs.writeFileSync(metadataPath(worktreePath), `${JSON.stringify(metadata, null, 2)}\n`);
  ensureMetadataExcluded(worktreePath);
  return metadata;
}

export function updateWorktreeMetadata(worktreePath: string, patch: Partial<WorktreeMetadata>): WorktreeMetadata | null {
  const existing = readWorktreeMetadata(worktreePath);
  if (!existing) return null;

  return writeWorktreeMetadata(worktreePath, {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export function setupMetadataFromPostHooks(postHooks: PostWorktreeResult): WorktreeMetadata["setup"] {
  return {
    status: postHooks.success ? "success" : "failed",
    message: postHooks.message,
    details: postHooks.details,
    commands: postHooks.commandsRun,
  };
}
