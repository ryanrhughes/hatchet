// Terminal launcher utilities
// Consolidated helpers for spawning terminal processes

import { execFileSync, execSync, spawn, spawnSync } from "child_process";
import * as os from "os";

/**
 * Check if a command exists in PATH
 */
export function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached process that continues after parent exits
 */
export function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Escape a path for shell use (single quotes)
 */
export function escapePath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

/**
 * Get the current platform
 */
export function getPlatform(): "darwin" | "linux" | "other" {
  const platform = os.platform();
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "other";
}

/**
 * Get the current terminal program (macOS)
 */
export function getTerminalProgram(): string | undefined {
  return process.env.TERM_PROGRAM;
}

export interface TerminalLaunchOptions {
  /** Working directory for the new terminal */
  path: string;
  /** Command to execute in the terminal (optional) */
  command?: string;
}

/**
 * Open a new terminal window at the given path, optionally running a command
 */
export function openTerminalWindow(options: TerminalLaunchOptions): boolean {
  const { path, command } = options;
  const platform = getPlatform();
  const escapedPath = escapePath(path);

  if (platform === "darwin") {
    return openTerminalWindowMacOS(path, escapedPath, command);
  } else if (platform === "linux") {
    return openTerminalWindowLinux(path, escapedPath, command);
  }

  return false;
}

/**
 * Wrap a command so that, after it exits (including Ctrl+C), the terminal stays
 * open in the current directory with an interactive shell.
 */
export function wrapCommandWithShell(command: string): string {
  return `__hatchet_shell=\${SHELL:-/bin/bash}; trap '' INT; ( trap - INT; ${command} ); printf '\\nHatchet: AI harness exited. Staying in this worktree. Type exit to return.\\n'; trap - INT; exec $__hatchet_shell -i`;
}

function openTerminalWindowMacOS(
  path: string,
  escapedPath: string,
  command?: string
): boolean {
  const termProgram = getTerminalProgram();
  const fullCommand = command
    ? `cd '${escapedPath}' && ${command}`
    : `cd '${escapedPath}'`;

  if (termProgram === "iTerm.app") {
    const script = `
      tell application "iTerm"
        create window with default profile
        tell current session of current window
          write text "${fullCommand}"
        end tell
      end tell
    `;
    spawnDetached("osascript", ["-e", script]);
    return true;
  }

  if (termProgram === "ghostty") {
    if (command) {
      spawnDetached("ghostty", [
        `--working-directory=${path}`,
        "-e",
        "sh",
        "-c",
        command,
      ]);
    } else {
      spawnDetached("ghostty", [`--working-directory=${path}`]);
    }
    return true;
  }

  // Default: Apple Terminal
  if (command) {
    const script = `
      tell application "Terminal"
        do script "${fullCommand}"
        activate
      end tell
    `;
    spawnDetached("osascript", ["-e", script]);
  } else {
    spawnDetached("open", ["-a", "Terminal", path]);
  }
  return true;
}

function openTerminalWindowLinux(
  path: string,
  escapedPath: string,
  command?: string
): boolean {
  // Try terminals in order of preference
  const terminals = [
    {
      name: "ghostty",
      spawn: () => {
        const args = [`--working-directory=${path}`];
        if (command) {
          args.push("-e", "sh", "-c", command);
        }
        spawnDetached("ghostty", args);
      },
    },
    {
      name: "gnome-terminal",
      spawn: () => {
        const args = [`--working-directory=${path}`];
        if (command) {
          args.push("--", "sh", "-c", command);
        }
        spawnDetached("gnome-terminal", args);
      },
    },
    {
      name: "konsole",
      spawn: () => {
        const args = ["--workdir", path];
        if (command) {
          args.push("-e", "sh", "-c", command);
        }
        spawnDetached("konsole", args);
      },
    },
    {
      name: "alacritty",
      spawn: () => {
        const args = ["--working-directory", path];
        if (command) {
          args.push("-e", "sh", "-c", command);
        }
        spawnDetached("alacritty", args);
      },
    },
    {
      name: "kitty",
      spawn: () => {
        const args = ["--directory", path];
        if (command) {
          args.push("sh", "-c", command);
        }
        spawnDetached("kitty", args);
      },
    },
    {
      name: "xterm",
      spawn: () => {
        const fullCmd = command
          ? `cd '${escapedPath}' && ${command}`
          : `cd '${escapedPath}' && $SHELL`;
        spawnDetached("xterm", ["-e", fullCmd]);
      },
    },
  ];

  for (const terminal of terminals) {
    if (hasCommand(terminal.name)) {
      terminal.spawn();
      return true;
    }
  }

  console.error("No supported terminal emulator found");
  return false;
}

/**
 * Run a command in place (takes over current terminal)
 * Destroys renderer, runs command, then exits
 */
export function runInPlace(
  path: string,
  command: string,
  destroyRenderer: () => void
): never {
  // Destroy renderer first
  destroyRenderer();

  // Change directory
  process.chdir(path);

  try {
    execSync(command, { stdio: "inherit", cwd: path });
  } catch {
    // Command exited
  }
  process.exit(0);
}

/**
 * Run a command in place, then leave the user in an interactive shell in that
 * directory. This cannot change the parent shell's cwd, so it intentionally
 * keeps a child shell alive in the worktree after the command exits.
 */
export function runInPlaceAndOpenShell(
  path: string,
  command: string,
  destroyRenderer: () => void
): never {
  // Destroy renderer first
  destroyRenderer();

  // Change directory before launching so the child shell and command both start
  // in the worktree.
  process.chdir(path);

  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);

  const result = spawnSync("sh", ["-c", wrapCommandWithShell(command)], {
    stdio: "inherit",
    cwd: path,
  });

  process.off("SIGINT", ignoreSigint);

  if (result.error) {
    console.error(`Could not launch command: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

/**
 * Open shell in place (takes over current terminal)
 */
export function openShellInPlace(
  path: string,
  destroyRenderer: () => void
): never {
  const shell = process.env.SHELL || "/bin/bash";
  return runInPlace(path, shell, destroyRenderer);
}
