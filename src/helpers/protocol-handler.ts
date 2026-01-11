// Protocol handler installation for hatchet:// URLs (Linux only)
// This allows links like:
//   hatchet://card/123?path=/home/user/project&launch-opencode=true
// to trigger Hatchet from the browser.

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";

/**
 * Find the hatchet executable path
 * Returns the path and whether it's a development setup
 */
function findHatchetPath(): { path: string; isDev: boolean } | null {
  // Check for system-installed binary first (from AUR package)
  if (existsSync("/usr/bin/hatchet")) {
    return { path: "/usr/bin/hatchet", isDev: false };
  }

  // Check if 'hatchet' is in PATH
  try {
    const whichResult = execSync("which hatchet 2>/dev/null", { encoding: "utf8" }).trim();
    if (whichResult) {
      return { path: whichResult, isDev: false };
    }
  } catch {
    // Not found in PATH
  }

  // Check ~/.bun/bin/hatchet (bun link installs here)
  const bunPath = join(homedir(), ".bun/bin/hatchet");
  if (existsSync(bunPath)) {
    return { path: bunPath, isDev: false };
  }

  // Check if we're running from development (src/main.ts exists in cwd)
  const devPath = join(process.cwd(), "src/main.ts");
  if (existsSync(devPath)) {
    return { path: devPath, isDev: true };
  }

  return null;
}

/**
 * Install the hatchet:// protocol handler on Linux
 */
export function installProtocolHandler(): void {
  console.log("Installing Hatchet protocol handler...");
  console.log("");

  // Find hatchet
  const hatchetInfo = findHatchetPath();
  if (!hatchetInfo) {
    console.error("Error: hatchet not found!");
    console.error("");
    console.error("Please install hatchet first:");
    console.error("  cd /path/to/hatchet");
    console.error("  bun link");
    console.error("");
    console.error("Or ensure it's in your PATH.");
    process.exit(1);
  }

  const { path: hatchetPath, isDev } = hatchetInfo;
  console.log(`Found hatchet at: ${hatchetPath}`);
  if (isDev) {
    console.log("Note: Using development path. For production, run 'bun link' first.");
  }

  // Determine the hatchet command
  const hatchetCmd = isDev ? `bun ${hatchetPath}` : hatchetPath;

  // Set up directories
  const home = homedir();
  const desktopDir = join(home, ".local/share/applications");
  const desktopFile = join(desktopDir, "hatchet-handler.desktop");
  const wrapperDir = join(home, ".local/bin");
  const wrapperPath = join(wrapperDir, "hatchet-protocol-wrapper");

  // Ensure directories exist
  mkdirSync(desktopDir, { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });

  // Create wrapper script that runs hatchet then drops to shell
  const wrapperScript = `#!/bin/bash
# Wrapper script for hatchet protocol handler
# Runs hatchet with the URL, then drops to a shell so the terminal stays open
${hatchetCmd} --url "$1"
exec bash
`;

  writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
  console.log(`Created wrapper script: ${wrapperPath}`);

  // Create .desktop file
  const desktopContent = `[Desktop Entry]
Name=Hatchet Protocol Handler
Comment=Git Worktree Manager - Protocol Handler for hatchet:// URLs
Exec=xdg-terminal-exec -- ${wrapperPath} %u
Type=Application
MimeType=x-scheme-handler/hatchet;
NoDisplay=true
Terminal=false
Categories=Development;
`;

  writeFileSync(desktopFile, desktopContent);
  console.log(`Created desktop file: ${desktopFile}`);

  // Register as handler
  try {
    execSync("xdg-mime default hatchet-handler.desktop x-scheme-handler/hatchet", {
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Warning: Failed to register mime type. You may need to run:");
    console.error("  xdg-mime default hatchet-handler.desktop x-scheme-handler/hatchet");
  }

  console.log("");
  console.log("Hatchet protocol handler installed successfully!");
  console.log("");
  console.log("Usage:");
  console.log("  hatchet://card/<number>?path=<repo-path>");
  console.log("  hatchet://card/<number>?path=<repo-path>&launch-opencode=true");
  console.log("  hatchet://card/<number>?path=<repo-path>&launch-opencode=true&with-context=true");
  console.log("");
  console.log("Test with:");
  console.log(`  xdg-open 'hatchet://card/123?path=${process.cwd()}'`);
  console.log("");

  // Print Chrome extension info
  const chromeExtPath = "/usr/share/hatchet/chrome-extension";
  if (existsSync(chromeExtPath)) {
    console.log("Chrome Extension:");
    console.log(`  Load unpacked extension from: ${chromeExtPath}`);
    console.log("  1. Open chrome://extensions");
    console.log("  2. Enable Developer mode");
    console.log("  3. Click 'Load unpacked' and select the directory above");
    console.log("");
  } else {
    // Development mode - point to local chrome-extension
    const devExtPath = join(process.cwd(), "chrome-extension");
    if (existsSync(devExtPath)) {
      console.log("Chrome Extension (development):");
      console.log(`  Load unpacked extension from: ${devExtPath}`);
      console.log("  1. Open chrome://extensions");
      console.log("  2. Enable Developer mode");
      console.log("  3. Click 'Load unpacked' and select the directory above");
      console.log("");
    }
  }
}
