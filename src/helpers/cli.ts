// CLI argument parsing for Hatchet
// Uses yargs following OpenCode's patterns

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export interface CliOptions {
  card?: number;
  path?: string;
  launchOpencode?: boolean;
  withContext?: boolean;
  list?: boolean;
  url?: string;
  installHandler?: boolean;
}

/**
 * Parse protocol URL: hatchet://card/123?path=/foo&launch-opencode=true&with-context=true
 * 
 * URL structure: hatchet://card/123?path=/foo&launch-opencode=true&with-context=true
 * - hostname = "card"
 * - pathname = "/123"
 * - searchParams = { path: "/foo", "launch-opencode": "true", "with-context": "true" }
 */
export function parseProtocolUrl(url: string): Partial<CliOptions> {
  try {
    const parsed = new URL(url);
    const options: Partial<CliOptions> = {};

    // hatchet://card/123 -> hostname="card", pathname="/123"
    // Parse card number from the combination of hostname and pathname
    if (parsed.hostname === "card") {
      const cardPath = parsed.pathname.replace(/^\/+/, "");
      const cardNum = parseInt(cardPath, 10);
      if (!isNaN(cardNum)) {
        options.card = cardNum;
      }
    }

    // Query params - match CLI flag names
    if (parsed.searchParams.has("path")) {
      options.path = parsed.searchParams.get("path")!;
    }
    if (parsed.searchParams.get("launch-opencode") === "true") {
      options.launchOpencode = true;
    }
    if (parsed.searchParams.get("with-context") === "true") {
      options.withContext = true;
    }

    return options;
  } catch {
    // Invalid URL, return empty options
    return {};
  }
}

/**
 * Parse command-line arguments
 */
export async function parseArgs(): Promise<CliOptions> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("hatchet")
    .usage("$0 [options]")
    .usage("")
    .usage("Git Worktree Manager with Fizzy integration")
    .usage("")
    .usage("Examples:")
    .usage("  $0                                    Launch TUI")
    .usage("  $0 --card 123 --path /path/to/repo    Create worktree for card #123")
    .usage("  $0 -c 123 -o                          Create and launch OpenCode")
    .usage("  $0 -c 123 -o --with-context           Include card context in prompt")
    .usage("  $0 --list                             List all worktrees")
    .option("card", {
      alias: "c",
      type: "number",
      describe: "Fizzy card number to create/switch worktree for",
    })
    .option("path", {
      alias: "p",
      type: "string",
      describe: "Path to git repository (required for protocol handler)",
    })
    .option("launch-opencode", {
      alias: "o",
      type: "boolean",
      describe: "Launch OpenCode in the worktree after creation",
      default: false,
    })
    .option("with-context", {
      type: "boolean",
      describe: "Include card context in OpenCode prompt (requires --launch-opencode)",
      default: false,
    })
    .option("list", {
      alias: "l",
      type: "boolean",
      describe: "List worktrees and exit",
      default: false,
    })
    .option("url", {
      type: "string",
      describe: "Protocol URL (used by protocol handler)",
      hidden: true, // Don't show in help
    })
    .option("install-handler", {
      type: "boolean",
      describe: "Install hatchet:// protocol handler (Linux)",
      default: false,
    })
    .help("help")
    .alias("help", "h")
    .version()
    .alias("version", "v")
    .strict()
    .parse();

  let options: CliOptions = {
    card: argv.card,
    path: argv.path,
    launchOpencode: argv.launchOpencode,
    withContext: argv.withContext,
    list: argv.list,
    url: argv.url,
    installHandler: argv.installHandler,
  };

  // If --url was passed, merge parsed URL options (URL options take precedence)
  if (options.url) {
    const urlOptions = parseProtocolUrl(options.url);
    options = { ...options, ...urlOptions };
  }

  return options;
}
