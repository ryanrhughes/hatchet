# Hatchet

A TUI for managing work via Fizzy and Git worktrees with automatic database cloning for Rails projects.

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

Optionally, add an alias to your shell config:

```bash
alias hatchet="bun ~/path/to/hatchet/src/main.ts"
```

## Features

- Create, switch, and remove Git worktrees
- Automatic SQLite database cloning for Rails projects
- Copies environment files (`.env.local`, `config/master.key`, etc.)
- Fizzy integration for task management

## Rails Database Cloning

When creating a worktree in a Rails project with SQLite, Hatchet automatically:

1. Parses `config/database.yml` directly (no Rails environment needed)
2. Finds all SQLite database files including:
   - Standard databases (`db/development.sqlite3`, `storage/*.sqlite3`)
   - Multi-tenant databases with `%{tenant}` patterns
   - WAL and SHM files for consistency
3. Copies everything to the new worktree

**No rake tasks or bin scripts required!** Just having a `database.yml` with SQLite is enough.

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

## License

MIT
