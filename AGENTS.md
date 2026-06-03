# Hatchet Development Guide

This document contains important patterns and conventions for developing the `hatchet` TUI application.

## Project Structure

- `src/main.ts` - Main application with all views
- `src/helpers/git.ts` - Git worktree operations
- `src/helpers/fizzy.ts` - Fizzy (task management) integration
- `src/helpers/project.ts` - Project detection and post-worktree hooks
- `src/helpers/html.ts` - HTML to TUI rendering
- `src/helpers/image.ts` - Image extraction and placeholders
- `src/helpers/terminal.ts` - Terminal launcher utilities
- `src/helpers/card-tile.ts` - Fizzy card tile component
- `src/helpers/pr-tile.ts` - GitHub PR tile component
- `src/helpers/github.ts` - GitHub PR integration (uses gh CLI)
- `src/helpers/config.ts` - Configuration file loading
- `src/helpers/cli.ts` - CLI argument parsing (yargs)
- `src/helpers/protocol-handler.ts` - Protocol handler installation logic
- `src/theme.ts` - Color theming system
- `src/types.ts` - TypeScript type definitions
- `scripts/install-protocol-handler.sh` - Protocol handler installer (bash, legacy)
- `chrome-extension/` - Chrome extension for Fizzy integration

## OpenTUI Key Event Handling

### The Enter Key Bleed-Through Problem

When navigating between views in OpenTUI, there's a critical timing issue with Enter key handling.

**Problem**: When pressing Enter on a `SelectRenderable`:
1. The `ITEM_SELECTED` event fires
2. Handler navigates to new view synchronously  
3. New view's `SelectRenderable` is focused in the same event loop tick
4. The same Enter keypress propagates to the new view and triggers its selection

**Solution**: Always use `process.nextTick()` to defer navigation:

```typescript
// WRONG - causes enter bleed-through
select.on(SelectRenderableEvents.ITEM_SELECTED, (_idx, opt) => {
  showNextView(renderer);
});

// CORRECT - defers to next tick
select.on(SelectRenderableEvents.ITEM_SELECTED, (_idx, opt) => {
  // Defer navigation to next tick to prevent enter key from bleeding through
  process.nextTick(() => showNextView(renderer));
});
```

This pattern must be applied to ALL `SelectRenderableEvents.ITEM_SELECTED` handlers that navigate to another view.

### Focus Deferral for New Views

When creating a new view with a `SelectRenderable`, also defer the focus call:

```typescript
// Defer focus to next tick to prevent Enter key from immediately triggering selection
setTimeout(() => {
  select.focus();
}, 0);
```

## View Navigation Pattern

Each view function follows this pattern:

1. Set `currentView` to track current state
2. Clear the root with `clearChildren(root)`
3. Build the new UI
4. Register key handlers (with cleanup functions)
5. Add content to root
6. Focus the primary interactive element (deferred with setTimeout)

## Key Handler Cleanup

Views that register custom key handlers must clean them up before navigating:

```typescript
let keyHandler: ((key: { name?: string }) => void) | null = null;

const cleanup = () => {
  if (keyHandler) {
    renderer.keyInput.off("keypress", keyHandler);
    keyHandler = null;
  }
};

// Use cleanup before any navigation
keyHandler = (key) => {
  if (key.name === "escape") {
    cleanup();
    showMainView(renderer);
  }
};
renderer.keyInput.on("keypress", keyHandler);
```

## Nerd Font Icons

The app uses Nerd Font icons via Unicode escapes:

```typescript
const ICONS = {
  branch: "\ue725",      // nf-dev-git_branch
  ahead: "\uf062",       // nf-fa-arrow_up
  behind: "\uf063",      // nf-fa-arrow_down
  clean: "\uf00c",       // nf-fa-check
  staged: "\uf067",      // nf-fa-plus
  modified: "\uf040",    // nf-fa-pencil
  untracked: "\uf128",   // nf-fa-question
  commit: "\uf417",      // nf-oct-git_commit
};
```

## Running and Testing

```bash
# Run the app (TUI mode)
bun hatchet

# Build/install/check
make build
make install
make check
make local-install

# Type check
npx tsc --noEmit

# Toggle console for debugging (in app)
Press ` (backtick)
```

## Command-Line Interface

Hatchet supports both interactive TUI mode and non-interactive CLI mode.

### CLI Options

```bash
hatchet [options]

Options:
  -c, --card <number>    Fizzy card number to create/switch worktree for
      --pr <number>      GitHub PR number to create/switch worktree for
      --review-pr <num>  Create a local latest-base merge worktree for PR review
  -p, --path <dir>       Path to git repository (required for protocol handler)
  -o, --launch-ai        Launch the configured AI harness in the worktree after creation
      --with-context     Include card/PR/review context in the AI prompt (requires -o)
  -l, --list             List worktrees and exit
      --install-handler  Install hatchet:// protocol handler (Linux)
  -h, --help             Show help
  -v, --version          Show version
```

### Examples

```bash
# Launch interactive TUI
hatchet

# Create/switch to worktree for card #123
hatchet --card 123

# Create/switch to worktree for PR #456
hatchet --pr 456

# Review PR #456 as merged onto the latest base branch
hatchet --review-pr 456
hatchet --review-pr 456 -o --with-context

# Create worktree and launch the configured AI harness
hatchet --card 123 --launch-ai
hatchet -c 123 -o
hatchet --pr 456 -o

# Create worktree and launch the configured AI harness with card/PR context in prompt
hatchet --card 123 --launch-ai --with-context
hatchet -c 123 -o --with-context
hatchet --pr 456 -o --with-context

# Work with a specific repo (useful for protocol handler)
hatchet --card 123 --path /home/user/myproject --launch-ai

# Register/use projects from anywhere
hatchet --add-repo herald --repo-path ~/Work/herald
hatchet --add-repo nebula --clone-repo git@github.com:org/nebula.git
hatchet --repo herald --card 123 -o --with-context
hatchet --list-repos

# List all worktrees
hatchet --list
```

## Protocol Handler (Linux)

Hatchet can be registered as a protocol handler for `hatchet://` URLs, allowing browser links to trigger worktree creation.

### Installation

```bash
# Using CLI (recommended)
hatchet --install-handler

# Or using script directly (development)
./scripts/install-protocol-handler.sh
```

This creates a `.desktop` file and registers Hatchet as the handler for `hatchet://` URLs.

### URL Format

```
hatchet://card/<number>?path=<repo-path>&launch-ai=true&with-context=true
hatchet://pr/<number>?path=<repo-path>&launch-ai=true&with-context=true
hatchet://review-pr/<number>?path=<repo-path>&launch-ai=true&with-context=true
```

**Parameters:**
- `card/<number>` - The Fizzy card number (for card URLs)
- `pr/<number>` - The GitHub PR number (for PR branch worktree URLs)
- `review-pr/<number>` - The GitHub PR number for latest-base review worktree URLs
- `path` - Absolute path to the git repository (required)
- `launch-ai` - Set to `true` to launch the configured AI harness after creation
- `with-context` - Set to `true` to include card/PR/review details in the AI prompt

Older `launch-opencode=true` URLs remain supported for compatibility.

### URL Examples

```
# Just create/switch to worktree for a card
hatchet://card/123?path=/home/user/myproject

# Create worktree for a PR
hatchet://pr/456?path=/home/user/myproject

# Create latest-base review worktree for a PR
hatchet://review-pr/456?path=/home/user/myproject

# Create and launch the configured AI harness
hatchet://card/123?path=/home/user/myproject&launch-ai=true
hatchet://pr/456?path=/home/user/myproject&launch-ai=true
hatchet://review-pr/456?path=/home/user/myproject&launch-ai=true

# Create, launch the configured AI harness, and include context
hatchet://card/123?path=/home/user/myproject&launch-ai=true&with-context=true
hatchet://pr/456?path=/home/user/myproject&launch-ai=true&with-context=true
hatchet://review-pr/456?path=/home/user/myproject&launch-ai=true&with-context=true
```

### Testing

```bash
# Test the protocol handler with a card
xdg-open 'hatchet://card/123?path=/home/user/myproject'

# Test the protocol handler with a PR
xdg-open 'hatchet://pr/456?path=/home/user/myproject'

# Test the protocol handler with PR review mode
xdg-open 'hatchet://review-pr/456?path=/home/user/myproject'
```

### Integration with Fizzy

To add "Open in Hatchet" links to your Fizzy board, you can create links like:

```html
<a href="hatchet://card/123?path=/home/user/myproject&launch-ai=true&with-context=true">
  Open in Hatchet
</a>
```

## Project Detection and Database Cloning

Hatchet automatically detects project types and clones databases when creating worktrees.

### Supported Project Types

- **Rails with SQLite**: Automatically clones all SQLite databases (no setup needed!)
- **Rails with PostgreSQL**: Detected but not cloned (use template databases)
- **Node/Bun**: No database hooks (future: could run `npm install` or `bun install`)

### How It Works (Rails + SQLite)

1. Hatchet parses `config/database.yml` directly (no Rails environment needed)
2. Handles ERB interpolations like `<%= ENV.fetch("VAR") { default } %>`
3. Handles YAML anchors and merge keys (`<<: *default`)
4. Finds all SQLite database files including:
   - Main database files (`storage/*.sqlite3`)
   - Multi-tenant databases with `%{tenant}` patterns
   - WAL and SHM files for consistency
5. Copies all files to the new worktree

### Files Copied Automatically

These files are copied from the main repo to the worktree if they exist:
- `.env`
- `.env.local`
- `.env.development.local`
- `config/master.key`
- `config/credentials/development.key`
- Any files specified in `additionalFilesToCopy` config option

### Database Module

The database parsing logic is in `src/helpers/database.ts`:

```typescript
import { parseDatabaseConfig, findDatabaseFiles, cloneDatabases } from "./database";

// Parse database.yml
const configs = parseDatabaseConfig("/path/to/project", "development");

// Find all SQLite files
const files = findDatabaseFiles("/path/to/project", configs);

// Clone to a new directory
const result = cloneDatabases("/path/to/source", "/path/to/target");
```

### Supported database.yml Patterns

```yaml
# Single database (older Rails)
development:
  adapter: sqlite3
  database: db/development.sqlite3

# Multi-database (Rails 6+)
development:
  primary:
    <<: *default
    database: storage/development.sqlite3
  cache:
    <<: *default
    database: storage/cache.sqlite3

# Multi-tenant (acts_as_tenant style)
development:
  primary:
    <<: *default
    database: storage/tenants/development/%{tenant}/main.sqlite3
    tenanted: true
```

## Session Isolation

**Problem**: When running multiple worktrees on different ports, they share the same session cookie (same localhost domain). Logging into one worktree logs you out of another.

**Solution**: Use separate browser profiles or private/incognito windows for each worktree. This is the simplest and most reliable approach.

## Port Assignment for Worktrees

When running multiple worktrees simultaneously, each needs its own port. Here's a `bin/dev` script that automatically finds a free port:

```ruby
#!/usr/bin/env ruby
require 'socket'

def find_free_port(start_port = 3000)
  port = start_port
  loop do
    begin
      TCPServer.new('127.0.0.1', port).close
      return port
    rescue Errno::EADDRINUSE
      port += 1
    end
  end
end

port = find_free_port
puts "Starting on port #{port}..."
exec "./bin/rails", "server", "-p", port.to_s, *ARGV
```

This way each worktree automatically gets the next available port (3000, 3001, 3002, etc.) without conflicts.

## Configuration

Hatchet supports configuration via JSONC files (JSON with comments). Config is loaded from:

1. `.hatchet.jsonc` in the project folder (repo root) - project-specific
2. `~/.config/hatchet/config.jsonc` - global config

Project config takes precedence over global config.

Hatchet also supports a global project registry at `~/.config/hatchet/projects.jsonc`. When launched outside a git repo, the TUI opens a project picker. Use `hatchet --add-repo <name> --repo-path <path>` or `hatchet --add-repo <name> --clone-repo <remote>` to populate it.

### Available Options

```jsonc
{
  // Skip copying SQLite databases when creating worktrees
  "skipDatabaseCopy": false,
  // Skip copying environment files (.env, .env.local, master.key, etc.)
  "skipEnvCopy": false,
  // AI launcher command used by `c` and `--launch-ai`
  "aiCommand": "omarchy-launch-ai",
  // Editor command used by `n`; defaults to $VISUAL, $EDITOR, then nvim
  "editorCommand": "nvim",
  // Optional dev command recorded in per-worktree metadata
  "devCommand": "bin/dev",
  // Setup commands run after creating a worktree
  "setupCommands": ["bundle install", "bin/rails db:prepare"],
  // Additional files to copy when creating worktrees (relative to repo root)
  "additionalFilesToCopy": ["special_file", "config/custom.yml"]
}
```

### Config Module

The config loading logic is in `src/helpers/config.ts`:

```typescript
import { loadConfig, getConfigValue } from "./config";

// Load full config
const config = loadConfig("/path/to/repo");

// Get a specific value
const skipDb = getConfigValue("/path/to/repo", "skipDatabaseCopy");
```
