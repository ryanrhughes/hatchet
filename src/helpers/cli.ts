// CLI argument parsing for Hatchet

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export interface CliOptions {
  card?: number;
  pr?: number;
  reviewPr?: number;
  path?: string;
  repo?: string;
  addRepo?: string;
  repoPath?: string;
  cloneRepo?: string;
  listRepos?: boolean;
  launchAi?: boolean;
  /** Deprecated compatibility alias for older URLs/CLI usage. */
  launchOpencode?: boolean;
  withContext?: boolean;
  list?: boolean;
  url?: string;
  installHandler?: boolean;
}

/**
 * Parse protocol URL: hatchet://card/123?path=/foo&launch-ai=true&with-context=true
 *                  or hatchet://pr/123?path=/foo&launch-ai=true&with-context=true
 *                  or hatchet://review-pr/123?path=/foo&launch-ai=true&with-context=true
 * 
 * URL structure: hatchet://<type>/123?path=/foo&launch-ai=true&with-context=true
 * - hostname = "card", "pr", or "review-pr"
 * - pathname = "/123"
 * - searchParams = { path: "/foo", "launch-ai": "true", "with-context": "true" }
 *
 * Older URLs using launch-opencode=true are still accepted.
 */
export function parseProtocolUrl(url: string): Partial<CliOptions> {
  try {
    const parsed = new URL(url);
    const options: Partial<CliOptions> = {};

    // hatchet://card/123 -> hostname="card", pathname="/123"
    // hatchet://pr/123 -> hostname="pr", pathname="/123"
    if (parsed.hostname === "card") {
      const cardPath = parsed.pathname.replace(/^\/+/, "");
      const cardNum = parseInt(cardPath, 10);
      if (!isNaN(cardNum)) {
        options.card = cardNum;
      }
    } else if (parsed.hostname === "pr") {
      const prPath = parsed.pathname.replace(/^\/+/, "");
      const prNum = parseInt(prPath, 10);
      if (!isNaN(prNum)) {
        options.pr = prNum;
      }
    } else if (parsed.hostname === "review-pr") {
      const prPath = parsed.pathname.replace(/^\/+/, "");
      const prNum = parseInt(prPath, 10);
      if (!isNaN(prNum)) {
        options.reviewPr = prNum;
      }
    }

    // Query params - match CLI flag names
    if (parsed.searchParams.has("path")) {
      options.path = parsed.searchParams.get("path")!;
    }
    if (parsed.searchParams.has("repo")) {
      options.repo = parsed.searchParams.get("repo")!;
    }
    if (parsed.searchParams.get("launch-ai") === "true" || parsed.searchParams.get("launch-opencode") === "true") {
      options.launchAi = true;
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
    .usage("  $0 --pr 456                           Create worktree for PR #456")
    .usage("  $0 --review-pr 456                    Review PR #456 against latest base")
    .usage("  $0 --repo herald --card 123 -o         Use a registered project")
    .usage("  $0 --add-repo herald --repo-path ~/Work/herald")
    .usage("  $0 -c 123 -o                          Create and launch AI harness")
    .usage("  $0 -c 123 -o --with-context           Include card/PR/review context")
    .usage("  $0 --list                             List all worktrees")
    .option("card", {
      alias: "c",
      type: "number",
      describe: "Fizzy card number to create/switch worktree for",
    })
    .option("pr", {
      type: "number",
      describe: "GitHub PR number to create/switch worktree for",
    })
    .option("review-pr", {
      type: "number",
      describe: "GitHub PR number to review against the latest base branch",
    })
    .option("path", {
      alias: "p",
      type: "string",
      describe: "Path to git repository (required for protocol handler)",
    })
    .option("repo", {
      type: "string",
      describe: "Registered Hatchet project name to use",
    })
    .option("add-repo", {
      type: "string",
      describe: "Add or update a registered Hatchet project by name",
    })
    .option("repo-path", {
      type: "string",
      describe: "Path for --add-repo, or clone destination for --clone-repo",
    })
    .option("clone-repo", {
      type: "string",
      describe: "Remote URL for --add-repo, cloned if the repo path is missing",
    })
    .option("list-repos", {
      type: "boolean",
      describe: "List registered Hatchet projects and exit",
      default: false,
    })
    .option("launch-ai", {
      alias: "o",
      type: "boolean",
      describe: "Launch the configured AI harness in the worktree after creation",
      default: false,
    })
    .option("launch-opencode", {
      type: "boolean",
      describe: "Deprecated alias for --launch-ai",
      default: false,
      hidden: true,
    })
    .option("with-context", {
      type: "boolean",
      describe: "Include card/PR/review context in the AI prompt (requires --launch-ai)",
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

  const launchAi = argv.launchAi || argv.launchOpencode;

  let options: CliOptions = {
    card: argv.card,
    pr: argv.pr,
    reviewPr: argv.reviewPr,
    path: argv.path,
    repo: argv.repo,
    addRepo: argv.addRepo,
    repoPath: argv.repoPath,
    cloneRepo: argv.cloneRepo,
    listRepos: argv.listRepos,
    launchAi,
    launchOpencode: launchAi,
    withContext: argv.withContext,
    list: argv.list,
    url: argv.url,
    installHandler: argv.installHandler,
  };

  // If --url was passed, merge parsed URL options (URL options take precedence)
  if (options.url) {
    const urlOptions = parseProtocolUrl(options.url);
    options = { ...options, ...urlOptions };
    if (urlOptions.launchAi || urlOptions.launchOpencode) {
      options.launchAi = true;
      options.launchOpencode = true;
    }
  }

  return options;
}
