import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { FizzyBoard, FizzyColumn, FizzyCard } from "../types";

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

// Use the fizzy CLI for all API calls (handles auth automatically)
function fizzyCmd(args: string[]): unknown {
  try {
    const result = execFileSync("fizzy", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(result);
    if (parsed.success === false) {
      throw new Error(parsed.error?.message || "Fizzy command failed");
    }
    return parsed;
  } catch (error) {
    const message = errorMessage(error);
    lastError = message;
    throw new Error(`Fizzy command failed: ${message}`);
  }
}

// Check if fizzy is authenticated
export function isAuthenticated(): boolean {
  try {
    const result = execFileSync("fizzy", ["auth", "status"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(result);
    return parsed.success === true;
  } catch {
    return false;
  }
}

// Get default board from config files
// Checks .fizzy.yaml in current directory first, then ~/.config/fizzy/config.yaml
export function getDefaultBoard(): { id: string; name: string } | null {
  // Check local .fizzy.yaml first
  const localConfig = ".fizzy.yaml";
  if (existsSync(localConfig)) {
    const board = parseBoardFromConfig(localConfig);
    if (board) return board;
  }

  // Check global config
  const home = process.env.HOME || "";
  const globalConfig = join(home, ".config", "fizzy", "config.yaml");
  if (existsSync(globalConfig)) {
    const board = parseBoardFromConfig(globalConfig);
    if (board) return board;
  }

  return null;
}

// Parse board from a YAML config file
function parseBoardFromConfig(path: string): { id: string; name: string } | null {
  try {
    const content = readFileSync(path, "utf-8");
    // Simple YAML parsing for board field
    // Looking for "board: <id>" or "board: <name>"
    const match = content.match(/^board:\s*(.+)$/m);
    if (match) {
      const boardValue = match[1].trim().replace(/^["']|["']$/g, "");
      
      // Try to find this board in the list to get both id and name
      const boards = fetchBoards();
      
      // Check if it matches an id or name
      const board = boards.find(b => b.id === boardValue || b.name === boardValue);
      if (board) {
        return { id: board.id, name: board.name };
      }
      
      // If not found in list but we have a value, assume it's an id
      if (boardValue) {
        return { id: boardValue, name: boardValue };
      }
    }
  } catch {
    // Ignore errors reading config
  }
  return null;
}

export function fetchBoards(): FizzyBoard[] {
  try {
    lastError = null;
    const response = fizzyCmd(["board", "list"]) as { data: FizzyBoard[] };
    const boards = response.data || [];
    // Sort alphabetically by name
    return boards.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function fetchColumns(boardId: string): FizzyColumn[] {
  try {
    lastError = null;
    const response = fizzyCmd(["column", "list", "--board", boardId]) as {
      data: FizzyColumn[];
    };
    const columns = response.data || [];
    // Sort by position
    return columns.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  } catch {
    return [];
  }
}

export function fetchCards(boardId: string, columnId?: string | null): FizzyCard[] {
  try {
    lastError = null;
    const args = ["card", "list", "--board", boardId, "--all"];
    if (columnId) {
      args.push("--column", columnId);
    }
    const response = fizzyCmd(args) as { data: FizzyCard[] };
    // Filter to only published cards
    const cards = response.data || [];
    return cards.filter(c => c.status === "published");
  } catch {
    return [];
  }
}

export function fetchCard(cardNumber: number): FizzyCard | null {
  try {
    lastError = null;
    const response = fizzyCmd(["card", "show", cardNumber.toString()]) as {
      data: FizzyCard;
    };
    return response.data || null;
  } catch {
    return null;
  }
}

// Cache for card details (includes steps)
const cardDetailsCache: Map<number, FizzyCard> = new Map();

export function fetchCardDetails(cardNumber: number): FizzyCard | null {
  // Check cache first
  if (cardDetailsCache.has(cardNumber)) {
    return cardDetailsCache.get(cardNumber)!;
  }
  
  const card = fetchCard(cardNumber);
  if (card) {
    cardDetailsCache.set(cardNumber, card);
  }
  return card;
}

export function clearCardCache(): void {
  cardDetailsCache.clear();
}

export function branchFromCard(card: FizzyCard, cardNumber: number): string {
  const title = card.title || "untitled";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");

  return `card-${cardNumber}-${slug}`;
}

// Parse card number from a branch name like "card-123-some-title"
export function parseCardFromBranch(branchName: string): number | null {
  const match = branchName.match(/^card-(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function generateInitialPrompt(
  card: FizzyCard,
  cardNumber: number
): string {
  const lines: string[] = [];

  lines.push("I'm starting work on a Fizzy card. Here are the details for context:");
  lines.push("");
  lines.push(`## Fizzy Card #${cardNumber}: ${card.title}`);
  lines.push("");

  if (card.description) {
    lines.push("### Description");
    lines.push(card.description);
    lines.push("");
  }

  if (card.steps && card.steps.length > 0) {
    lines.push("### Steps");
    for (const step of card.steps) {
      const checkbox = step.completed ? "[x]" : "[ ]";
      lines.push(`- ${checkbox} ${step.content}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Please acknowledge that you've received these card details and wait for my instructions on how to proceed.");

  return lines.join("\n");
}

export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<div[^>]*>|<\/div>/g, "")
    .replace(/<h1[^>]*>(.*?)<\/h1>/gm, "# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gm, "## $1\n\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gm, "### $1\n\n")
    .replace(/<p[^>]*>(.*?)<\/p>/gm, "$1\n\n")
    .replace(/<ul[^>]*>(.*?)<\/ul>/gm, "$1\n")
    .replace(/<ol[^>]*>(.*?)<\/ol>/gm, "$1\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gm, "- $1\n")
    .replace(/<code[^>]*>(.*?)<\/code>/gm, "`$1`")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gm, "**$1**")
    .replace(/<em[^>]*>(.*?)<\/em>/gm, "*$1*")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
