# Hatchet

A TUI for managing work via Fizzy and Git worktrees with automatic database cloning for Rails projects.

![Main Screen](screenshots/main-screen.png)

## Installation

### Arch Linux (AUR)

```bash
yay -S hatchet
```

### From Source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/ryanrhughes/hatchet.git
cd hatchet
bun install
bun hatchet
```

### Shell Alias

Add an `ht` alias for quick access:

#### Bash

Add to `~/.bashrc`:

```bash
alias ht="hatchet"
```

#### Zsh

Add to `~/.zshrc`:

```bash
alias ht="hatchet"
```

#### Fish

Create `~/.config/fish/conf.d/hatchet.fish`:

```fish
alias ht="hatchet"
```

#### From Source

If running from source, point the alias to bun:

```bash
# Bash/Zsh
alias ht="bun ~/path/to/hatchet/src/main.ts"

# Fish (~/.config/fish/conf.d/hatchet.fish)
alias ht="bun ~/path/to/hatchet/src/main.ts"
```

## Features

- Create, switch, and remove Git worktrees
- Launch multiple tools (Opencode, NeoVim, Terminal) in your worktree
- Automatic SQLite database cloning for Rails projects
- Copies environment files (`.env.local`, `config/master.key`, etc.)
- Fizzy integration for task management (via [fizzy-cli](https://github.com/robzolkos/fizzy-cli))

### Deleting Worktrees

![Delete Worktree](screenshots/delete-worktree.gif)

## Fizzy Integration

Hatchet integrates with [Fizzy](https://fizzy.do) for task management. To use Fizzy features, install [fizzy-cli](https://github.com/robzolkos/fizzy-cli) and run `fizzy setup`.

Once configured, Hatchet can:
- Display your Fizzy boards and cards
- Create worktrees directly from Fizzy cards
- Change worktrees for easy context switching
- Seed Opencode sessions with Fizzy card details

> **Pro tip:** Set your `board` in your project's `.fizzy.yaml` to skip board selection.

### Create Worktrees from Fizzy Cards
With `fizzy-cli`, you're able to create worktrees directly from cards in Fizzy without leaving Hatchet.

![Create Worktree from Card](screenshots/create-worktree-from-card.gif)

![Fizzy Columns](screenshots/fizzy-columns.png)

![Fizzy Card List](screenshots/fizzy-card-list.png)

### Load Context from Fizzy

When a worktree is created from Fizzy, you'll be given the option to include the contents of the card when launching OpenCode to assist in getting you started even faster!

![Fizzy Context Option](screenshots/fizzy-context-option.png)

![OpenCode Prompt](screenshots/opencode.png)

## Rails Database Cloning

When creating a worktree in a Rails project with SQLite, Hatchet automatically:

1. Parses `config/database.yml` directly (no Rails environment needed)
2. Finds all SQLite database files including:
   - Standard databases (`db/development.sqlite3`, `storage/*.sqlite3`)
   - Multi-tenant databases with `%{tenant}` patterns
   - WAL and SHM files for consistency
3. Copies everything to the new worktree

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

### Files Copied Automatically

These files are copied from the main repo to the worktree if they exist:

- `.env.local`
- `.env.development.local`
- `config/master.key`
- `config/credentials/development.key`

## Running Multiple Worktrees

### Port Assignment

Each worktree needs its own port. Add this `bin/dev` script to your Rails project for automatic port assignment:

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

Each worktree automatically gets the next available port (3000, 3001, 3002, etc.).

### Session Isolation

When running multiple worktrees on different ports, they share the same session cookie (same localhost domain). Logging into one worktree logs you out of another.

**Solution**: Use separate browser profiles or private/incognito windows for each worktree.
