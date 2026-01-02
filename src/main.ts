#!/usr/bin/env bun

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  ASCIIFontRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import type { FizzyCard } from "./types";
import * as git from "./helpers/git";
import * as fizzy from "./helpers/fizzy";
import { Theme, detectPalette, getFizzyColor, getFizzyColorDimmed } from "./theme";
import { renderHtml } from "./helpers/html";
import { createCardTile } from "./helpers/card-tile";
import { 
  extractImageUrls, 
  createImagePlaceholder,
  type ImageInfo 
} from "./helpers/image";
import * as terminal from "./helpers/terminal";

// Helper to clear all children from a renderable (no removeAll() in OpenTUI)
function clearChildren(parent: Renderable): void {
  // Get a copy of children array to avoid issues during iteration
  const children = [...parent.getChildren()];
  for (const child of children) {
    try {
      child.destroyRecursively();
    } catch {
      // Ignore errors from already-destroyed nodes
    }
  }
}

// Safe view transition helper
function transitionToView(showView: () => void): void {
  if (isTransitioning) return;
  isTransitioning = true;
  process.nextTick(() => {
    showView();
    isTransitioning = false;
  });
}

// Helper for list navigation with wrap-around
function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

// ============================================================================
// Reusable UI Components
// ============================================================================

interface ModalOptions {
  title: string;
  subtitle?: string;
  width?: number;
  statusText?: string;
}

interface ModalComponents {
  container: BoxRenderable;
  modal: BoxRenderable;
  content: BoxRenderable;
}

// Create a modal dialog with consistent styling
function createModal(renderer: CliRenderer, options: ModalOptions): ModalComponents {
  const { title, subtitle, width = 50, statusText } = options;

  // Full screen centered container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Theme.transparent,
  });

  // Modal box with border
  const modal = new BoxRenderable(renderer, {
    width,
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    borderStyle: "rounded",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });

  // Header row
  const headerRow = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: Theme.transparent,
    marginBottom: 1,
  });
  headerRow.add(new TextRenderable(renderer, {
    content: title,
    fg: Theme.accent,
  }));
  if (subtitle) {
    headerRow.add(new TextRenderable(renderer, {
      content: subtitle,
      fg: Theme.muted,
    }));
  }
  modal.add(headerRow);

  // Content area (caller adds their content here)
  const content = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });
  modal.add(content);

  // Status bar at bottom
  if (statusText) {
    modal.add(new TextRenderable(renderer, { content: "" }));
    modal.add(new TextRenderable(renderer, {
      content: statusText,
      fg: Theme.muted,
    }));
  }

  container.add(modal);

  return { container, modal, content };
}

// ============================================================================
// Button Group Component
// ============================================================================

interface ButtonConfig {
  label: string;
  /** Color when selected (default: Theme.selected) */
  selectedBg?: string;
  /** Border color when selected (default: Theme.accent) */
  selectedBorder?: string;
}

interface ButtonGroupComponents {
  container: BoxRenderable;
  buttons: BoxRenderable[];
  texts: TextRenderable[];
  /** Update button visual styles based on selection */
  updateSelection: (selectedIndex: number) => void;
}

/**
 * Create a horizontal button group for confirmation dialogs
 */
function createButtonGroup(
  renderer: CliRenderer,
  buttonConfigs: ButtonConfig[]
): ButtonGroupComponents {
  const container = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "center",
    gap: 2,
    backgroundColor: Theme.transparent,
  });

  const buttons: BoxRenderable[] = [];
  const texts: TextRenderable[] = [];

  for (let i = 0; i < buttonConfigs.length; i++) {
    const config = buttonConfigs[i];
    const isFirst = i === 0;

    const button = new BoxRenderable(renderer, {
      flexDirection: "row",
      backgroundColor: isFirst ? Theme.selected : Theme.transparent,
      paddingLeft: 2,
      paddingRight: 2,
      border: true,
      borderColor: isFirst ? Theme.accent : Theme.muted,
      borderStyle: "rounded",
    });

    const text = new TextRenderable(renderer, {
      content: config.label,
      fg: isFirst ? Theme.textBright : Theme.text,
    });

    button.add(text);
    container.add(button);
    buttons.push(button);
    texts.push(text);
  }

  const updateSelection = (selectedIndex: number) => {
    for (let i = 0; i < buttons.length; i++) {
      const config = buttonConfigs[i];
      const isSelected = i === selectedIndex;

      if (isSelected) {
        buttons[i].backgroundColor = config.selectedBg ?? Theme.selected;
        buttons[i].borderColor = config.selectedBorder ?? Theme.accent;
        texts[i].fg = Theme.textBright;
      } else {
        buttons[i].backgroundColor = Theme.transparent;
        buttons[i].borderColor = Theme.muted;
        texts[i].fg = Theme.text;
      }
    }
  };

  return { container, buttons, texts, updateSelection };
}

// ============================================================================
// Selection List Component
// ============================================================================

interface SelectionListOptions<T> {
  renderer: CliRenderer;
  /** The view name for guard checks */
  viewName: ViewType;
  /** Title shown in the header */
  title: string;
  /** Subtitle shown in the header (right side) */
  subtitle?: string;
  /** Modal width (default: 50) */
  width?: number;
  /** Items to select from */
  items: T[];
  /** Render a tile for an item */
  renderItem: (item: T, selected: boolean) => BoxRenderable;
  /** Called when an item is selected */
  onSelect: (item: T) => void;
  /** Called when back/escape is pressed */
  onBack: () => void;
  /** Optional footer text (e.g., tips) */
  footerText?: string;
  /** Status bar text (default: "j/k navigate  enter select  esc back") */
  statusText?: string;
}

interface SelectionListComponents {
  container: BoxRenderable;
  /** Call this to clean up the key handler */
  cleanup: () => void;
}

/**
 * Create a selection list with keyboard navigation
 */
function createSelectionList<T>(options: SelectionListOptions<T>): SelectionListComponents {
  const {
    renderer,
    viewName,
    title,
    subtitle,
    width = 50,
    items,
    renderItem,
    onSelect,
    onBack,
    footerText,
    statusText = "j/k navigate  enter select  esc back",
  } = options;

  // Full screen container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Theme.transparent,
  });

  // Modal-style box
  const modal = new BoxRenderable(renderer, {
    width,
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    borderStyle: "rounded",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });

  // Header
  const headerRow = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: Theme.transparent,
    marginBottom: 1,
  });
  headerRow.add(new TextRenderable(renderer, {
    content: title,
    fg: Theme.accent,
  }));
  if (subtitle) {
    headerRow.add(new TextRenderable(renderer, {
      content: subtitle,
      fg: Theme.muted,
    }));
  }
  modal.add(headerRow);

  // Tiles container
  const tilesContainer = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });
  modal.add(tilesContainer);

  // Selection state
  let selectedIndex = 0;
  const tiles: BoxRenderable[] = [];
  let isDestroyed = false;

  // Build tiles
  let isRebuilding = false;
  const rebuildTiles = () => {
    if (isRebuilding || isDestroyed) return;
    isRebuilding = true;

    // Clear existing tiles
    for (const tile of tiles) {
      tilesContainer.remove(tile.id);
      tile.destroyRecursively();
    }
    tiles.length = 0;

    // Create new tiles
    items.forEach((item, index) => {
      const tile = renderItem(item, index === selectedIndex);
      tiles.push(tile);
      tilesContainer.add(tile);
    });

    isRebuilding = false;
  };

  rebuildTiles();

  // Footer text (e.g., tips)
  if (footerText) {
    modal.add(new TextRenderable(renderer, { content: "" }));
    modal.add(new TextRenderable(renderer, {
      content: footerText,
      fg: Theme.muted,
    }));
  }

  // Status bar
  modal.add(new TextRenderable(renderer, { content: "" }));
  modal.add(new TextRenderable(renderer, {
    content: statusText,
    fg: Theme.muted,
  }));

  container.add(modal);

  // Key handler
  const keyHandler = (key: { name?: string }) => {
    if (currentView !== viewName || isDestroyed || isTransitioning) return;

    if (key.name === "j" || key.name === "down") {
      selectedIndex = wrapIndex(selectedIndex + 1, items.length);
      rebuildTiles();
    } else if (key.name === "k" || key.name === "up") {
      selectedIndex = wrapIndex(selectedIndex - 1, items.length);
      rebuildTiles();
    } else if (key.name === "return" || key.name === "enter") {
      isDestroyed = true;
      renderer.keyInput.off("keypress", keyHandler);
      const item = items[selectedIndex];
      transitionToView(() => onSelect(item));
    } else if (key.name === "escape") {
      isDestroyed = true;
      renderer.keyInput.off("keypress", keyHandler);
      transitionToView(() => onBack());
    }
  };
  renderer.keyInput.on("keypress", keyHandler);

  const cleanup = () => {
    isDestroyed = true;
    renderer.keyInput.off("keypress", keyHandler);
  };

  return { container, cleanup };
}

// ============================================================================
// Selection List Tile Helpers
// ============================================================================

/** Create a standard text tile */
function createTextTile(
  renderer: CliRenderer,
  text: string,
  selected: boolean,
  options?: { 
    description?: string;
    borderColor?: string;
    selectedBorderColor?: string;
  }
): BoxRenderable {
  const { description, borderColor = Theme.muted, selectedBorderColor = Theme.accent } = options ?? {};
  
  const tile = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    border: true,
    borderColor: selected ? selectedBorderColor : borderColor,
    borderStyle: "rounded",
    backgroundColor: Theme.transparent,
    paddingLeft: 1,
    paddingRight: 1,
    marginBottom: 1,
  });

  tile.add(new TextRenderable(renderer, {
    content: text,
    fg: selected ? Theme.textBright : Theme.text,
  }));

  if (description) {
    tile.add(new TextRenderable(renderer, {
      content: description,
      fg: Theme.muted,
    }));
  }

  return tile;
}

/** Create a back button tile */
function createBackTile(renderer: CliRenderer, selected: boolean): BoxRenderable {
  const tile = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    border: true,
    borderColor: selected ? Theme.accent : Theme.muted,
    borderStyle: "rounded",
    backgroundColor: Theme.transparent,
    paddingLeft: 1,
    paddingRight: 1,
  });
  tile.add(new TextRenderable(renderer, {
    content: "\u2190 Back",
    fg: selected ? Theme.accent : Theme.muted,
  }));
  return tile;
}

// Track current view for navigation
type ViewType = "main" | "create" | "fizzy-boards" | "fizzy-columns" | "fizzy-cards" | "confirm" | "switch-confirm" | "delete-confirm";
let currentView: ViewType = "main";
// Flag to prevent operations during view transitions
let isTransitioning = false;

// Track the current board and column for navigation
let currentBoard: { id: string; name: string } | null = null;
let currentColumnId: string | null = null;
// Track if the board was manually selected (vs auto-selected from config)
let boardManuallySelected = false;

// Fizzy authentication status (checked once at startup)
let fizzyAuthenticated = false;

// Track last created branch to select it when returning to main view
let lastCreatedBranch: string | null = null;

async function main() {
  // Check if we're in a git repo
  if (!git.inGitRepo()) {
    console.error("Error: Not a git repository");
    process.exit(1);
  }

  // Check Fizzy authentication status once at startup
  fizzyAuthenticated = fizzy.isAuthenticated();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  });

  // Console available but hidden by default (toggle with backtick `)

  // Detect terminal palette for theming
  await detectPalette(renderer);

  // Global key handler - only escape goes back/exits globally
  renderer.keyInput.on("keypress", (key) => {
    // Backtick toggles console
    if (key.name === "`" || key.name === '"') {
      renderer.console.toggle();
      return;
    }
    
    if (key.name === "escape") {
      if (isTransitioning) return;
      
      if (currentView === "main") {
        renderer.destroy();
        process.exit(0);
      } else if (currentView === "fizzy-cards" || currentView === "fizzy-boards" || currentView === "fizzy-columns") {
        // Don't handle here - let the view's own handler deal with it
        return;
      } else if (currentView === "confirm") {
        // Go back to cards view
        if (currentBoard) {
          transitionToView(() => showFizzyCards(renderer, currentBoard!, currentColumnId));
        } else {
          transitionToView(() => showMainView(renderer));
        }
      } else if (currentView === "switch-confirm" || currentView === "delete-confirm") {
        // Go back to main worktree list
        transitionToView(() => showMainView(renderer));
      } else {
        transitionToView(() => showMainView(renderer));
      }
    }
  });

  showMainView(renderer);
  renderer.start();
}

// Special marker values for non-worktree options
const CREATE_NEW = Symbol("create-new");
const CREATE_FROM_FIZZY = Symbol("create-from-fizzy");

function showMainView(renderer: CliRenderer) {
  currentView = "main";
  const root = renderer.root;
  clearChildren(root);

  const worktrees = git.worktrees();

  // Full screen container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
  });

  // Header row with logo and repo name
  const header = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.transparent,
    marginBottom: 1,
  });

  // Hatchet logo
  const logo = new TextRenderable(renderer, {
    content: "🪓 Hatchet",
    fg: Theme.primary,
  });
  header.add(logo);

  // Spacer and repo name
  const headerRight = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "flex-end",
    justifyContent: "center",
    backgroundColor: Theme.transparent,
  });
  headerRight.add(new TextRenderable(renderer, {
    content: git.repoName(),
    fg: Theme.secondary,
  }));
  headerRight.add(new TextRenderable(renderer, {
    content: "Git Worktree Manager",
    fg: Theme.muted,
  }));
  header.add(headerRight);
  container.add(header);

  // Main content area - two columns
  const mainArea = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    backgroundColor: Theme.transparent,
    gap: 2,
  });

  // Left panel - worktree list
  const leftPanel = new BoxRenderable(renderer, {
    width: "50%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    borderStyle: "rounded",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  });

  leftPanel.add(new TextRenderable(renderer, {
    content: "Worktrees",
    fg: Theme.accent,
  }));
  leftPanel.add(new TextRenderable(renderer, { content: "" }));

  // Sort worktrees: main/master first, then alphabetically
  const isMainBranch = (branch: string) => branch === "main" || branch === "master";
  const sortedWorktrees = [...worktrees].sort((a, b) => {
    const aIsMain = isMainBranch(a.branch);
    const bIsMain = isMainBranch(b.branch);
    if (aIsMain && !bIsMain) return -1;
    if (!aIsMain && bIsMain) return 1;
    return a.branch.localeCompare(b.branch);
  });

  // Build items list: worktrees + create options
  type ListItem = { type: "worktree"; wt: typeof worktrees[0] } | { type: "create"; action: symbol; label: string; desc: string; icon: string };
  const items: ListItem[] = [
    ...sortedWorktrees.map(wt => ({ type: "worktree" as const, wt })),
    { type: "create", action: CREATE_NEW, label: "New worktree", desc: "Create from current HEAD", icon: "\uf067" }, // nf-fa-plus
  ];
  
  // Only show Fizzy option if authenticated
  if (fizzyAuthenticated) {
    items.push({ type: "create", action: CREATE_FROM_FIZZY, label: "From Fizzy card", desc: "Create from a task card", icon: "\uf0ae" }); // nf-fa-tasks
  } else {
    items.push({ type: "create", action: CREATE_FROM_FIZZY, label: "Auth Fizzy to pull cards", desc: "Run: fizzy auth login", icon: "\uf023" }); // nf-fa-lock
  }

  // Custom list with styled tiles
  // Find initial selection based on lastCreatedBranch
  let selectedIndex = 0;
  if (lastCreatedBranch) {
    const idx = items.findIndex(item => 
      item.type === "worktree" && item.wt.branch === lastCreatedBranch
    );
    if (idx >= 0) {
      selectedIndex = idx;
    }
    lastCreatedBranch = null; // Clear after using
  }
  
  const listContainer = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    backgroundColor: Theme.transparent,
  });

  // Nerd Font icons (using Unicode escapes to ensure they're preserved)
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

  // Function to create a worktree tile
  const createWorktreeTile = (wt: typeof worktrees[0], selected: boolean) => {
    const isMain = isMainBranch(wt.branch);
    const status = git.getBranchStatus(wt.path);
    
    const tile = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      backgroundColor: selected ? Theme.selected : Theme.transparent,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
    });

    // Top row: branch name + status indicators
    const topRow = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      backgroundColor: Theme.transparent,
    });

    // Branch icon and name with special styling for main
    if (isMain) {
      topRow.add(new TextRenderable(renderer, {
        content: `${ICONS.branch} `,
        fg: Theme.primary,
      }));
      topRow.add(new TextRenderable(renderer, {
        content: wt.branch,
        fg: selected ? Theme.primaryBright : Theme.primary,
      }));
    } else {
      topRow.add(new TextRenderable(renderer, {
        content: `${ICONS.branch} `,
        fg: Theme.muted,
      }));
      topRow.add(new TextRenderable(renderer, {
        content: wt.branch,
        fg: selected ? Theme.textBright : Theme.text,
      }));
    }

    // Status indicators on the right
    const statusIndicators = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 1,
      backgroundColor: Theme.transparent,
    });

    // Ahead/behind
    if (status.ahead > 0) {
      statusIndicators.add(new TextRenderable(renderer, { content: `${ICONS.ahead}${status.ahead}`, fg: Theme.success }));
    }
    if (status.behind > 0) {
      statusIndicators.add(new TextRenderable(renderer, { content: `${ICONS.behind}${status.behind}`, fg: Theme.warning }));
    }

    // Working tree status
    if (status.dirty) {
      if (status.staged > 0) {
        statusIndicators.add(new TextRenderable(renderer, { content: `${ICONS.staged}${status.staged}`, fg: Theme.success }));
      }
      if (status.unstaged > 0) {
        statusIndicators.add(new TextRenderable(renderer, { content: `${ICONS.modified}${status.unstaged}`, fg: Theme.warning }));
      }
      if (status.untracked > 0) {
        statusIndicators.add(new TextRenderable(renderer, { content: `${ICONS.untracked}${status.untracked}`, fg: Theme.muted }));
      }
    } else {
      statusIndicators.add(new TextRenderable(renderer, { content: ICONS.clean, fg: Theme.success }));
    }

    topRow.add(statusIndicators);
    tile.add(topRow);

    // Bottom row: last commit info with hash
    if (status.lastCommit) {
      const commitRow = new BoxRenderable(renderer, {
        flexDirection: "row",
        backgroundColor: Theme.transparent,
      });
      commitRow.add(new TextRenderable(renderer, {
        content: `${ICONS.commit} `,
        fg: Theme.muted,
      }));
      commitRow.add(new TextRenderable(renderer, {
        content: status.lastCommit.hash,
        fg: Theme.secondary,
      }));
      commitRow.add(new TextRenderable(renderer, {
        content: ` ${status.lastCommit.message}`,
        fg: Theme.muted,
      }));
      tile.add(commitRow);
    }

    return tile;
  };

  // Function to create a "create" action tile
  const createActionTile = (label: string, desc: string, selected: boolean, icon: string) => {
    const tile = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      backgroundColor: selected ? Theme.selected : Theme.transparent,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
    });

    const topRow = new BoxRenderable(renderer, {
      flexDirection: "row",
      backgroundColor: Theme.transparent,
    });
    
    topRow.add(new TextRenderable(renderer, {
      content: `${icon} `,
      fg: Theme.accent,
    }));
    topRow.add(new TextRenderable(renderer, {
      content: label,
      fg: selected ? Theme.textBright : Theme.text,
    }));
    
    tile.add(topRow);
    tile.add(new TextRenderable(renderer, {
      content: desc,
      fg: Theme.muted,
    }));

    return tile;
  };

  // Rebuild the list
  const rebuildList = () => {
    clearChildren(listContainer);
    
    items.forEach((item, index) => {
      const selected = index === selectedIndex;
      if (item.type === "worktree") {
        listContainer.add(createWorktreeTile(item.wt, selected));
      } else {
        listContainer.add(createActionTile(item.label, item.desc, selected, item.icon));
      }
    });
  };

  // Get selected item
  const getSelectedItem = () => items[selectedIndex];
  
  // Get selected worktree (if any)
  const getSelectedWorktree = () => {
    const item = getSelectedItem();
    return item?.type === "worktree" ? item.wt : null;
  };

  rebuildList();
  leftPanel.add(listContainer);
  mainArea.add(leftPanel);

  // Right panel - details/preview
  const rightPanel = new BoxRenderable(renderer, {
    width: "50%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    borderStyle: "rounded",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  });

  rightPanel.add(new TextRenderable(renderer, {
    content: "Details",
    fg: Theme.accent,
  }));
  rightPanel.add(new TextRenderable(renderer, { content: "" }));

  // Detail content (will be updated on selection change)
  const detailContent = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });
  rightPanel.add(detailContent);
  mainArea.add(rightPanel);

  // Function to update detail panel
  const updateDetails = () => {
    clearChildren(detailContent);
    const item = getSelectedItem();
    
    if (!item) return;
    
    if (item.type === "create") {
      if (item.action === CREATE_NEW) {
        detailContent.add(new TextRenderable(renderer, { content: "Create New Worktree", fg: Theme.text }));
        detailContent.add(new TextRenderable(renderer, { content: "" }));
        detailContent.add(new TextRenderable(renderer, { content: "Press Enter to create a new branch", fg: Theme.muted }));
        detailContent.add(new TextRenderable(renderer, { content: "and worktree from the current HEAD.", fg: Theme.muted }));
      } else if (item.action === CREATE_FROM_FIZZY) {
        if (fizzyAuthenticated) {
          detailContent.add(new TextRenderable(renderer, { content: "Create from Fizzy Card", fg: Theme.text }));
          detailContent.add(new TextRenderable(renderer, { content: "" }));
          detailContent.add(new TextRenderable(renderer, { content: "Browse your Fizzy boards and create", fg: Theme.muted }));
          detailContent.add(new TextRenderable(renderer, { content: "a worktree from a task card.", fg: Theme.muted }));
        } else {
          detailContent.add(new TextRenderable(renderer, { content: "Fizzy Not Authenticated", fg: Theme.warning }));
          detailContent.add(new TextRenderable(renderer, { content: "" }));
          detailContent.add(new TextRenderable(renderer, { content: "To pull cards from Fizzy, run:", fg: Theme.muted }));
          detailContent.add(new TextRenderable(renderer, { content: "" }));
          detailContent.add(new TextRenderable(renderer, { content: "  fizzy auth login", fg: Theme.accent }));
          detailContent.add(new TextRenderable(renderer, { content: "" }));
          detailContent.add(new TextRenderable(renderer, { content: "Then restart wt.", fg: Theme.muted }));
        }
      }
    } else {
      const wt = item.wt;
      const isMain = isMainBranch(wt.branch);
      
      // Branch name with badge for main
      detailContent.add(new TextRenderable(renderer, { content: "Branch", fg: Theme.muted }));
      if (isMain) {
        const branchRow = new BoxRenderable(renderer, {
          flexDirection: "row",
          gap: 1,
          backgroundColor: Theme.transparent,
        });
        branchRow.add(new TextRenderable(renderer, { content: wt.branch, fg: Theme.primary }));
        branchRow.add(new TextRenderable(renderer, { content: "(default)", fg: Theme.muted }));
        detailContent.add(branchRow);
      } else {
        detailContent.add(new TextRenderable(renderer, { content: wt.branch, fg: Theme.text }));
      }
      detailContent.add(new TextRenderable(renderer, { content: "" }));
      
      // Path
      detailContent.add(new TextRenderable(renderer, { content: "Path", fg: Theme.muted }));
      detailContent.add(new TextRenderable(renderer, { content: wt.path, fg: Theme.text }));
      detailContent.add(new TextRenderable(renderer, { content: "" }));
      
      // Get branch status (already cached from tile creation)
      const status = git.getBranchStatus(wt.path);
      
      // Status line (ahead/behind + dirty)
      detailContent.add(new TextRenderable(renderer, { content: "Status", fg: Theme.muted }));
      
      const statusParts: string[] = [];
      if (status.ahead > 0) statusParts.push(`↑${status.ahead} ahead`);
      if (status.behind > 0) statusParts.push(`↓${status.behind} behind`);
      if (status.ahead === 0 && status.behind === 0) statusParts.push("Up to date with remote");
      
      detailContent.add(new TextRenderable(renderer, { 
        content: statusParts.join(", "), 
        fg: (status.ahead > 0 || status.behind > 0) ? Theme.warning : Theme.success 
      }));
      
      if (status.dirty) {
        const changes: string[] = [];
        if (status.staged > 0) changes.push(`${status.staged} staged`);
        if (status.unstaged > 0) changes.push(`${status.unstaged} modified`);
        if (status.untracked > 0) changes.push(`${status.untracked} untracked`);
        detailContent.add(new TextRenderable(renderer, { content: changes.join(", "), fg: Theme.warning }));
      } else {
        detailContent.add(new TextRenderable(renderer, { content: "Working tree clean", fg: Theme.success }));
      }
      detailContent.add(new TextRenderable(renderer, { content: "" }));
      
      // Recent commits
      if (status.recentCommits.length > 0) {
        detailContent.add(new TextRenderable(renderer, { content: "Recent Commits", fg: Theme.muted }));
        
        for (const commit of status.recentCommits) {
          const commitRow = new BoxRenderable(renderer, {
            flexDirection: "row",
            backgroundColor: Theme.transparent,
          });
          commitRow.add(new TextRenderable(renderer, { 
            content: commit.hash, 
            fg: Theme.secondary 
          }));
          commitRow.add(new TextRenderable(renderer, { 
            content: ` ${commit.message}`, 
            fg: Theme.text 
          }));
          detailContent.add(commitRow);
          
          detailContent.add(new TextRenderable(renderer, { 
            content: `  ${commit.relativeDate} by ${commit.author}`, 
            fg: Theme.muted 
          }));
        }
        detailContent.add(new TextRenderable(renderer, { content: "" }));
      }
      
      // Check if it's a Fizzy card branch
      const cardNumber = fizzy.parseCardFromBranch(wt.branch);
      if (cardNumber) {
        detailContent.add(new TextRenderable(renderer, { content: "Fizzy Card", fg: Theme.muted }));
        detailContent.add(new TextRenderable(renderer, { content: `#${cardNumber}`, fg: Theme.accent }));
      }
    }
  };
  
  // Initial update
  updateDetails();

  container.add(mainArea);

  // Footer with keybindings
  const footer = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "center",
    backgroundColor: Theme.transparent,
    marginTop: 1,
    gap: 2,
  });

  // Helper to create a keybind hint
  const addKeybind = (key: string, label: string) => {
    const hint = new BoxRenderable(renderer, {
      flexDirection: "row",
      backgroundColor: Theme.transparent,
    });
    hint.add(new TextRenderable(renderer, { content: key, fg: Theme.accent }));
    hint.add(new TextRenderable(renderer, { content: ` ${label}`, fg: Theme.muted }));
    footer.add(hint);
  };

  addKeybind("o", "opencode");
  addKeybind("n", "nvim");
  addKeybind("t", "terminal");
  addKeybind("d", "delete");
  addKeybind("⇧", "new window");
  addKeybind("q", "quit");

  container.add(footer);
  root.add(container);

  // Key handler reference for cleanup
  let keyHandler: ((key: { name?: string }) => void) | null = null;

  // Helper to clean up key handler
  const cleanup = () => {
    if (keyHandler) {
      renderer.keyInput.off("keypress", keyHandler);
      keyHandler = null;
    }
  };

  // Navigation helpers
  const moveSelection = (delta: number) => {
    let newIndex = selectedIndex + delta;
    // Wrap around
    if (newIndex < 0) {
      newIndex = items.length - 1;
    } else if (newIndex >= items.length) {
      newIndex = 0;
    }
    selectedIndex = newIndex;
    rebuildList();
    updateDetails();
  };

  const selectCurrent = () => {
    const item = getSelectedItem();
    if (!item) return;

    if (item.type === "create") {
      // Defer navigation to next tick to prevent enter key from bleeding through
      // See AGENTS.md for explanation of this pattern
      if (item.action === CREATE_NEW) {
        cleanup();
        transitionToView(() => showCreateWorktree(renderer));
      } else if (item.action === CREATE_FROM_FIZZY) {
        // Only proceed if authenticated
        if (!fizzyAuthenticated) {
          // Do nothing - user needs to run fizzy auth login
          return;
        }
        cleanup();
        // Check for default board in config
        const defaultBoard = fizzy.getDefaultBoard();
        if (defaultBoard) {
          currentBoard = defaultBoard;
          boardManuallySelected = false;
          transitionToView(() => showFizzyColumns(renderer, defaultBoard));
        } else {
          transitionToView(() => showFizzyBoards(renderer));
        }
      }
    } else {
      // It's a worktree - launch opencode
      launchWithTool("opencode");
    }
  };

  // Helper to launch with selected worktree
  const launchWithTool = (tool: "opencode" | "nvim" | "terminal", newWindow: boolean = false) => {
    const wt = getSelectedWorktree();
    if (!wt) return;
    
    const worktreePath = wt.path;
    
    if (tool === "opencode") {
      // Check if this looks like a Fizzy card branch
      const cardNumber = fizzy.parseCardFromBranch(wt.branch);
      if (cardNumber) {
        const card = fizzy.fetchCardDetails(cardNumber);
        if (card) {
          cleanup();
          showSwitchWithContextPrompt(renderer, worktreePath, card, cardNumber, newWindow);
          return;
        }
      }
      
      if (newWindow) {
        launchOpenCodeInNewWindow(renderer, worktreePath);
      } else {
        cleanup();
        launchOpenCode(renderer, worktreePath);
      }
    } else if (tool === "nvim") {
      if (newWindow) {
        launchNvim(renderer, worktreePath);
      } else {
        cleanup();
        launchNvimInPlace(renderer, worktreePath);
      }
    } else if (tool === "terminal") {
      if (newWindow) {
        launchTerminal(renderer, worktreePath);
      } else {
        cleanup();
        launchShellInPlace(renderer, worktreePath);
      }
    }
  };

  // Key handlers
  keyHandler = (key: { name?: string; shift?: boolean }) => {
    if (currentView !== "main" || isTransitioning) return;
    
    const newWindow = key.shift === true;
    
    // Navigation
    if (key.name === "j" || key.name === "down") {
      moveSelection(1);
    } else if (key.name === "k" || key.name === "up") {
      moveSelection(-1);
    } else if (key.name === "return" || key.name === "enter") {
      selectCurrent();
    }
    // Launch tools
    else if (key.name === "o" || key.name === "O") {
      launchWithTool("opencode", newWindow);
    } else if (key.name === "n" || key.name === "N") {
      launchWithTool("nvim", newWindow);
    } else if (key.name === "t" || key.name === "T") {
      launchWithTool("terminal", newWindow);
    } else if (key.name === "d") {
      const wt = getSelectedWorktree();
      if (wt) {
        cleanup();
        transitionToView(() => showDeleteConfirm(renderer, wt));
      }
    } else if (key.name === "q") {
      renderer.destroy();
      process.exit(0);
    }
  };
  renderer.keyInput.on("keypress", keyHandler);
}

function showDeleteConfirm(renderer: CliRenderer, worktree: { branch: string; path: string }) {
  currentView = "delete-confirm";
  const root = renderer.root;
  clearChildren(root);

  // Create centered container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Theme.transparent,
  });

  // Modal box with border
  const modal = new BoxRenderable(renderer, {
    width: 50,
    flexDirection: "column",
    alignItems: "center",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.warning,
    borderStyle: "rounded",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });

  // Warning title
  modal.add(
    new TextRenderable(renderer, {
      content: "Delete Worktree?",
      fg: Theme.warning,
    })
  );
  modal.add(new TextRenderable(renderer, { content: "" }));

  // Info
  modal.add(
    new TextRenderable(renderer, {
      content: worktree.branch,
      fg: Theme.text,
    })
  );
  modal.add(
    new TextRenderable(renderer, {
      content: worktree.path.replace(process.env.HOME || "", "~"),
      fg: Theme.muted,
    })
  );
  modal.add(new TextRenderable(renderer, { content: "" }));

  // Button group
  let selectedIndex = 0;
  const buttonGroup = createButtonGroup(renderer, [
    { label: "Cancel" },
    { label: "Delete", selectedBg: Theme.error, selectedBorder: Theme.error },
  ]);
  modal.add(buttonGroup.container);

  // Key handler
  const keyHandler = (key: { name?: string }) => {
    if (currentView !== "delete-confirm" || isTransitioning) return;
    
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l" || key.name === "tab") {
      selectedIndex = selectedIndex === 0 ? 1 : 0;
      buttonGroup.updateSelection(selectedIndex);
    } else if (key.name === "return" || key.name === "enter") {
      renderer.keyInput.off("keypress", keyHandler);
      if (selectedIndex === 1) {
        git.removeWorktree(worktree.branch);
      }
      transitionToView(() => showMainView(renderer));
    } else if (key.name === "escape") {
      renderer.keyInput.off("keypress", keyHandler);
      transitionToView(() => showMainView(renderer));
    }
  };
  renderer.keyInput.on("keypress", keyHandler);

  // Status
  modal.add(new TextRenderable(renderer, { content: "" }));
  modal.add(
    new TextRenderable(renderer, {
      content: "←/→ select  enter confirm  esc cancel",
      fg: Theme.muted,
    })
  );

  container.add(modal);
  root.add(container);
}

function showCreateWorktree(renderer: CliRenderer) {
  currentView = "create";
  const root = renderer.root;
  clearChildren(root);

  // Create modal
  const { container, content } = createModal(renderer, {
    title: "Create New Worktree",
    subtitle: git.repoName(),
    width: 50,
    statusText: "enter create  esc back",
  });

  // Branch name label
  content.add(new TextRenderable(renderer, {
    content: "Branch name",
    fg: Theme.muted,
  }));

  // Input field in a bordered box
  const inputBox = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    border: true,
    borderColor: Theme.accent,
    borderStyle: "rounded",
    backgroundColor: Theme.transparent,
    paddingLeft: 1,
    paddingRight: 1,
  });

  const input = new InputRenderable(renderer, {
    width: "100%",
    height: 1,
    placeholder: "feature/my-branch",
    backgroundColor: Theme.transparent,
    focusedBackgroundColor: Theme.transparent,
    textColor: Theme.text,
    focusedTextColor: Theme.text,
    placeholderColor: Theme.muted,
    cursorColor: Theme.primary,
  });

  inputBox.add(input);
  content.add(inputBox);

  // Preview of what will be created
  const previewBox = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
    marginTop: 1,
  });
  
  const previewLabel = new TextRenderable(renderer, {
    content: "Will create:",
    fg: Theme.muted,
  });
  previewBox.add(previewLabel);
  
  const previewPath = new TextRenderable(renderer, {
    content: "",
    fg: Theme.secondary,
  });
  previewBox.add(previewPath);
  content.add(previewBox);

  // Update preview as user types
  const updatePreview = () => {
    const branchName = input.value.trim();
    if (branchName) {
      const sanitized = branchName
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9\-_/.]/g, "")
        .replace(/^[-.]+|[-.]+$/g, "");
      const folderName = sanitized.replace(/\//g, "-");
      previewPath.content = `${git.repoName()}.${folderName}/`;
    } else {
      previewPath.content = "";
    }
  };

  input.on(InputRenderableEvents.INPUT, updatePreview);

  input.on(InputRenderableEvents.ENTER, () => {
    if (isTransitioning) return;
    const branchName = input.value.trim();
    if (branchName) {
      try {
        git.createWorktree(branchName);
        // Track the sanitized branch name so we can select it in main view
        lastCreatedBranch = branchName
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9\-_/.]/g, "")
          .replace(/^[-.]+|[-.]+$/g, "");
        transitionToView(() => showMainView(renderer));
      } catch (error) {
        // Show error - for now just go back
        transitionToView(() => showMainView(renderer));
      }
    }
  });

  root.add(container);
  
  // Defer focus to next tick to prevent Enter key from immediately triggering
  setTimeout(() => input.focus(), 0);
}

function showFizzyBoards(renderer: CliRenderer) {
  currentView = "fizzy-boards";
  const root = renderer.root;
  clearChildren(root);

  // Fetch boards
  const boards = fizzy.fetchBoards();

  // Handle empty state
  if (boards.length === 0) {
    const { container, modal } = createModal(renderer, {
      title: "Select Board",
      subtitle: git.repoName(),
      width: 50,
    });
    modal.add(new TextRenderable(renderer, {
      content: "No boards found. Check Fizzy configuration.",
      fg: Theme.warning,
    }));
    modal.add(new TextRenderable(renderer, { content: "" }));
    modal.add(new TextRenderable(renderer, {
      content: "esc back",
      fg: Theme.muted,
    }));
    root.add(container);
    return;
  }

  // Build items list - boards + back option
  type BoardItem = { type: "board"; board: typeof boards[0] } | { type: "back" };
  const items: BoardItem[] = boards.map(board => ({ type: "board", board }));
  items.push({ type: "back" });

  const { container } = createSelectionList<BoardItem>({
    renderer,
    viewName: "fizzy-boards",
    title: "Select Board",
    subtitle: git.repoName(),
    width: 50,
    items,
    renderItem: (item, selected) => {
      if (item.type === "back") {
        return createBackTile(renderer, selected);
      }
      return createTextTile(renderer, item.board.name, selected, {
        description: item.board.description,
      });
    },
    onSelect: (item) => {
      if (item.type === "back") {
        showMainView(renderer);
      } else {
        currentBoard = item.board;
        boardManuallySelected = true;
        showFizzyColumns(renderer, item.board);
      }
    },
    onBack: () => showMainView(renderer),
    footerText: "Tip: Add board: <name> to .fizzy.yaml to skip this",
  });

  root.add(container);
}

function showFizzyColumns(renderer: CliRenderer, board: { id: string; name: string }) {
  try {
    currentView = "fizzy-columns";
    const root = renderer.root;
    clearChildren(root);

    // Fetch columns
    const columns = fizzy.fetchColumns(board.id);
    
    // Build items list - "All columns" first, then individual columns (excluding Done), then Back
    type ColumnItem = { type: "all" } | { type: "column"; column: typeof columns[0] } | { type: "back" };
    const items: ColumnItem[] = [{ type: "all" }];
    
    for (const col of columns) {
      // Skip "Done" column by default
      if (col.name === "Done") continue;
      items.push({ type: "column", column: col });
    }
    items.push({ type: "back" });

    // Render function for column tiles
    const renderColumnTile = (item: ColumnItem, selected: boolean): BoxRenderable => {
      if (item.type === "all") {
        return createTextTile(renderer, "All columns", selected, {
          selectedBorderColor: Theme.accent,
        });
      } else if (item.type === "back") {
        return createBackTile(renderer, selected);
      } else {
        // Column tile with color indicator
        const col = item.column;
        const colColor = getFizzyColor(col.color?.value);
        
        const tile = new BoxRenderable(renderer, {
          width: "100%",
          flexDirection: "row",
          alignItems: "center",
          border: true,
          borderColor: selected ? colColor : getFizzyColorDimmed(col.color?.value),
          borderStyle: "rounded",
          backgroundColor: Theme.transparent,
          paddingLeft: 1,
          paddingRight: 1,
          marginBottom: 1,
        });
        
        // Color dot
        tile.add(new TextRenderable(renderer, {
          content: "\u25cf",  // filled circle
          fg: colColor,
        }));
        tile.add(new TextRenderable(renderer, {
          content: `  ${col.name}`,
          fg: selected ? Theme.textBright : Theme.text,
        }));
        
        return tile;
      }
    };

    const { container } = createSelectionList<ColumnItem>({
      renderer,
      viewName: "fizzy-columns",
      title: "Select Column",
      subtitle: board.name,
      width: 45,
      items,
      renderItem: renderColumnTile,
      onSelect: (item) => {
        if (item.type === "back") {
          // Go back to boards if manually selected, otherwise main view
          if (boardManuallySelected) {
            showFizzyBoards(renderer);
          } else {
            showMainView(renderer);
          }
        } else if (item.type === "all") {
          showFizzyCards(renderer, board, null);
        } else {
          showFizzyCards(renderer, board, item.column.id as string);
        }
      },
      onBack: () => {
        // Go back to boards if manually selected, otherwise main view
        if (boardManuallySelected) {
          showFizzyBoards(renderer);
        } else {
          showMainView(renderer);
        }
      },
    });

    root.add(container);

  } catch (e) {
    console.error("showFizzyColumns error:", e);
  }
}

function showFizzyCards(renderer: CliRenderer, board: { id: string; name: string }, columnId: string | null = null) {
  currentView = "fizzy-cards";
  currentColumnId = columnId;
  const root = renderer.root;
  clearChildren(root);

  // Fetch cards (filtered by column if specified)
  const allCards = fizzy.fetchCards(board.id, columnId);
  let filteredCards = [...allCards];

  // Main container - full screen
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });

  // Header row
  const headerRow = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: Theme.transparent,
  });
  headerRow.add(
    new TextRenderable(renderer, {
      content: `🪓 Hatchet │ ${git.repoName()} │ ${board.name}`,
      fg: Theme.primary,
    })
  );
  container.add(headerRow);
  container.add(new TextRenderable(renderer, { content: "" }));

  // Filter input row
  const filterRow = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    flexDirection: "row",
    backgroundColor: Theme.transparent,
  });
  filterRow.add(
    new TextRenderable(renderer, {
      content: "Filter: ",
      fg: Theme.muted,
    })
  );
  const filterInput = new InputRenderable(renderer, {
    width: 40,
    height: 1,
    placeholder: "type to filter cards...",
    backgroundColor: Theme.backgroundSubtle,
    focusedBackgroundColor: Theme.backgroundSubtle,
    textColor: Theme.text,
    focusedTextColor: Theme.text,
    placeholderColor: Theme.muted,
    cursorColor: Theme.primary,
  });
  filterRow.add(filterInput);
  container.add(filterRow);
  container.add(new TextRenderable(renderer, { content: "" }));

  // Two-pane content area
  const contentRow = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    backgroundColor: Theme.transparent,
  });

  // Left pane - card list
  const leftPane = new BoxRenderable(renderer, {
    width: "40%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    marginRight: 1,
  });

  leftPane.add(
    new TextRenderable(renderer, {
      content: "Cards",
      fg: Theme.accent,
    })
  );

  // Preview pane reference (will be populated)
  let previewContent: BoxRenderable;
  
  // Track current card's images for external opening
  let currentCardImages: ImageInfo[] = [];

  // Function to update preview - fetches full card details for steps
  function updatePreview(card: FizzyCard | null) {
    if (!previewContent) return;
    clearChildren(previewContent);
    currentCardImages = [];

    if (!card) {
      previewContent.add(
        new TextRenderable(renderer, {
          content: "Select a card to see preview",
          fg: Theme.muted,
        })
      );
      return;
    }

    // Fetch full card details (includes steps, cached)
    const fullCard = fizzy.fetchCardDetails(card.number) || card;

    // Render header with styled text
    previewContent.add(
      new TextRenderable(renderer, {
        content: `#${fullCard.number}: ${fullCard.title}`,
        fg: Theme.textBright,
        attributes: 1, // Bold
      })
    );
    
    if (card.column_title || card.column?.name) {
      previewContent.add(
        new TextRenderable(renderer, {
          content: `Status: ${card.column_title || card.column?.name}`,
          fg: Theme.muted,
        })
      );
    }
    
    // Spacer
    previewContent.add(new TextRenderable(renderer, { content: "" }));

    // Render description from HTML if available
    if (fullCard.description_html) {
      renderHtml(renderer, previewContent, fullCard.description_html);
      
      // Extract images and show placeholders
      currentCardImages = extractImageUrls(fullCard.description_html);
      if (currentCardImages.length > 0) {
        previewContent.add(
          new TextRenderable(renderer, {
            content: `\n📷 ${currentCardImages.length} image${currentCardImages.length > 1 ? "s" : ""} (press 'o' to open)`,
            fg: Theme.muted,
          })
        );
        
        for (const image of currentCardImages) {
          const placeholder = createImagePlaceholder(renderer, {
            width: 30,
            height: 4,
            altText: image.alt,
          });
          previewContent.add(placeholder);
        }
      }
    } else if (fullCard.description) {
      // Plain text fallback
      previewContent.add(
        new TextRenderable(renderer, {
          content: fullCard.description,
          fg: Theme.text,
        })
      );
    }

    // Render steps
    if (fullCard.steps && fullCard.steps.length > 0) {
      const completed = fullCard.steps.filter(s => s.completed).length;
      
      previewContent.add(new TextRenderable(renderer, { content: "" }));
      previewContent.add(
        new TextRenderable(renderer, {
          content: `Steps (${completed}/${fullCard.steps.length})`,
          fg: Theme.accent,
          attributes: 1, // Bold
        })
      );
      
      for (const step of fullCard.steps) {
        const checkbox = step.completed ? "✓" : "○";
        const color = step.completed ? Theme.success : Theme.text;
        previewContent.add(
          new TextRenderable(renderer, {
            content: `${checkbox} ${step.content}`,
            fg: color,
          })
        );
      }
    }
  }
  
  // Function to open images in external viewer
  function openImagesExternally() {
    if (currentCardImages.length === 0) return;
    
    for (const image of currentCardImages) {
      // Use xdg-open on Linux, open on macOS
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      Bun.spawn([opener, image.url], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }

  // Custom key handler for pane switching and navigation
  let focusedPane: "filter" | "list" = "list";
  
  const keyHandler = (key: { name: string }) => {
    // Only handle keys when this view is active
    if (currentView !== "fizzy-cards" || isTransitioning) return;
    
    if (key.name === "tab") {
      if (focusedPane === "list") {
        focusedPane = "filter";
        filterInput.focus();
      } else {
        focusedPane = "list";
        filterInput.blur();
      }
    } else if (key.name === "/" && focusedPane === "list") {
      focusedPane = "filter";
      filterInput.focus();
      // Clear the "/" that gets typed into the input
      setTimeout(() => {
        if (filterInput.value === "/") {
          filterInput.value = "";
        } else if (filterInput.value.endsWith("/")) {
          filterInput.value = filterInput.value.slice(0, -1);
        }
      }, 0);
    } else if (key.name === "escape") {
      if (focusedPane === "filter") {
        // Escape from filter goes back to list
        focusedPane = "list";
        filterInput.blur();
      } else {
        // Escape from list goes back to columns
        renderer.keyInput.off("keypress", keyHandler);
        transitionToView(() => showFizzyColumns(renderer, board));
      }
    } else if (key.name === "return" || key.name === "enter") {
      if (focusedPane === "filter") {
        // Enter from filter goes back to list
        focusedPane = "list";
        filterInput.blur();
      } else {
        // Enter from list selects current card
        selectCurrentCard();
      }
    } else if (focusedPane === "list") {
      // Navigation keys for card list
      if (key.name === "j" || key.name === "down") {
        updateSelection(selectedIndex + 1);
      } else if (key.name === "k" || key.name === "up") {
        updateSelection(selectedIndex - 1);
      } else if (key.name === "o") {
        // Open images in external viewer
        openImagesExternally();
      }
    }
  };

  // Card list state
  let selectedIndex = 0;
  let cardScrollBox: ScrollBoxRenderable | null = null;
  let cardTiles: BoxRenderable[] = [];
  let backTileTextRenderable: TextRenderable | null = null;
  let backTile: BoxRenderable | null = null;

  // Get the column color for a card
  const getCardColumnColor = (card: FizzyCard) => {
    const columnColorVar = card.column?.color?.value;
    return {
      selected: getFizzyColor(columnColorVar),
      dimmed: getFizzyColorDimmed(columnColorVar),
    };
  };

  // Function to build card list (called once, or when filter changes)
  function buildCardList() {
    // Remove old scroll box if exists
    if (cardScrollBox) {
      leftPane.remove(cardScrollBox.id);
      cardScrollBox.destroyRecursively();
    }
    cardTiles = [];

    // Create scrollable container for cards
    cardScrollBox = new ScrollBoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      backgroundColor: Theme.transparent,
    });

    // Add styled card tiles
    filteredCards.forEach((card, index) => {
      const tile = createCardTile(renderer, {
        card,
        selected: index === selectedIndex,
        width: "100%",
      });
      cardTiles.push(tile);
      cardScrollBox!.add(tile);
    });

    // Add back option as a simple styled tile
    backTile = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      border: true,
      borderColor: selectedIndex === filteredCards.length ? Theme.accent : Theme.muted,
      borderStyle: "rounded",
      backgroundColor: Theme.backgroundSubtle,
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 0,
    });
    backTileTextRenderable = new TextRenderable(renderer, {
      content: "\u2190 Back to columns",
      fg: selectedIndex === filteredCards.length ? Theme.accent : Theme.text,
    });
    backTile.add(backTileTextRenderable);
    cardTiles.push(backTile);
    cardScrollBox.add(backTile);

    leftPane.add(cardScrollBox);

    // Update preview with selected card
    if (filteredCards.length > 0 && selectedIndex < filteredCards.length) {
      updatePreview(filteredCards[selectedIndex]);
    } else {
      updatePreview(null);
    }
  }

  // Update selection highlight without rebuilding the list
  function updateSelectionStyle(oldIndex: number, newIndex: number) {
    // Update old tile to non-selected style
    if (oldIndex >= 0 && oldIndex < cardTiles.length) {
      if (oldIndex < filteredCards.length) {
        // It's a card tile - update border color
        const card = filteredCards[oldIndex];
        const colors = getCardColumnColor(card);
        cardTiles[oldIndex].borderColor = colors.dimmed;
      } else if (backTile && backTileTextRenderable) {
        // It's the back tile
        backTile.borderColor = Theme.muted;
        backTileTextRenderable.fg = Theme.text;
      }
    }

    // Update new tile to selected style
    if (newIndex >= 0 && newIndex < cardTiles.length) {
      if (newIndex < filteredCards.length) {
        // It's a card tile - update border color
        const card = filteredCards[newIndex];
        const colors = getCardColumnColor(card);
        cardTiles[newIndex].borderColor = colors.selected;
      } else if (backTile && backTileTextRenderable) {
        // It's the back tile
        backTile.borderColor = Theme.accent;
        backTileTextRenderable.fg = Theme.accent;
      }
    }
  }

  // Update selection and scroll
  function updateSelection(newIndex: number) {
    const totalItems = filteredCards.length + 1; // includes back option
    const oldIndex = selectedIndex;
    selectedIndex = wrapIndex(newIndex, totalItems);
    
    // Update visual styling in place (no rebuild)
    updateSelectionStyle(oldIndex, selectedIndex);
    
    // Update preview
    if (selectedIndex < filteredCards.length) {
      updatePreview(filteredCards[selectedIndex]);
    } else {
      updatePreview(null);
    }
    
    // Scroll to ensure selected card is visible
    scrollToSelected();
  }
  
  // Scroll to ensure selected item is visible
  function scrollToSelected() {
    if (!cardScrollBox || cardTiles.length === 0 || selectedIndex >= cardTiles.length) return;
    
    // Use scrollHeight and estimate position based on uniform tile assumption
    // since actual heights may not be available until after render
    const contentHeight = cardScrollBox.scrollHeight;
    const numTiles = cardTiles.length;
    const avgTileHeight = contentHeight / numTiles;
    
    const tileTop = selectedIndex * avgTileHeight;
    const tileBottom = tileTop + avgTileHeight;
    
    const viewportHeight = cardScrollBox.viewport.height;
    const currentScroll = cardScrollBox.scrollTop;
    
    // If selected item is above viewport, scroll up
    if (tileTop < currentScroll) {
      cardScrollBox.scrollTop = tileTop;
    }
    // If selected item is below viewport, scroll down
    else if (tileBottom > currentScroll + viewportHeight) {
      cardScrollBox.scrollTop = tileBottom - viewportHeight;
    }
  }

  // Handle card selection
  function selectCurrentCard() {
    if (selectedIndex === filteredCards.length) {
      // Back option selected
      renderer.keyInput.off("keypress", keyHandler);
      showFizzyColumns(renderer, board);
    } else if (selectedIndex < filteredCards.length) {
      renderer.keyInput.off("keypress", keyHandler);
      createWorktreeFromCard(renderer, filteredCards[selectedIndex]);
    }
  }

  // Right pane - preview
  const rightPane = new BoxRenderable(renderer, {
    width: "60%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  });

  rightPane.add(
    new TextRenderable(renderer, {
      content: "Preview",
      fg: Theme.accent,
    })
  );
  rightPane.add(new TextRenderable(renderer, { content: "" }));

  previewContent = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });
  rightPane.add(previewContent);

  // Handle empty state
  if (allCards.length === 0) {
    leftPane.add(
      new TextRenderable(renderer, {
        content: "No cards found.",
        fg: Theme.warning,
      })
    );
  } else {
    buildCardList();
  }

  contentRow.add(leftPane);
  contentRow.add(rightPane);
  container.add(contentRow);

  // Status bar
  container.add(new TextRenderable(renderer, { content: "" }));
  container.add(
    new TextRenderable(renderer, {
      content: "/ filter  j/k navigate  enter select  esc back  tab switch pane",
      fg: Theme.muted,
    })
  );

  root.add(container);

  // Filter input handler
  filterInput.on(InputRenderableEvents.INPUT, () => {
    const query = filterInput.value.toLowerCase();
    if (query === "") {
      filteredCards = [...allCards];
    } else {
      filteredCards = allCards.filter(
        (card) =>
          card.title.toLowerCase().includes(query) ||
          card.number.toString().includes(query) ||
          (card.description || "").toLowerCase().includes(query) ||
          (card.tags || []).some(tag => tag.toLowerCase().includes(query))
      );
    }
    selectedIndex = 0; // Reset selection on filter
    buildCardList(); // Full rebuild needed when filter changes
  });

  // Register key handler
  renderer.keyInput.on("keypress", keyHandler);
}

function createWorktreeFromCard(renderer: CliRenderer, card: { number: number; title: string }) {
  try {
    // Generate branch name from card
    const branchName = fizzy.branchFromCard(card as any, card.number);
    
    // Get card details for prompt
    const fullCard = fizzy.fetchCard(card.number);
    const prompt = fullCard ? fizzy.generateInitialPrompt(fullCard, card.number) : undefined;
    
    // Check if worktree already exists
    if (git.worktreeExists(branchName)) {
      const existingPath = git.worktreePath(branchName);
      if (existingPath) {
        // Ask user what to do - set lastCreatedBranch so we select it if user cancels
        lastCreatedBranch = branchName;
        showWorktreeExistsPrompt(renderer, card, branchName, existingPath, prompt);
        return;
      }
    }
    
    // Create new worktree and return to main view
    // Track the branch so we can select it in the main view
    git.createWorktree(branchName);
    lastCreatedBranch = branchName;
    showMainView(renderer);
  } catch (error) {
    // Show error - for now just go back
    showMainView(renderer);
  }
}

function showWorktreeExistsPrompt(
  renderer: CliRenderer, 
  card: { number: number; title: string },
  branchName: string,
  existingPath: string,
  _prompt?: string
) {
  currentView = "confirm";
  const root = renderer.root;
  clearChildren(root);

  // Create centered container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Theme.transparent,
  });

  // Modal box with border
  const modal = new BoxRenderable(renderer, {
    width: 55,
    flexDirection: "column",
    alignItems: "center",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.warning,
    borderStyle: "rounded",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });

  // Warning title
  modal.add(
    new TextRenderable(renderer, {
      content: "Worktree Already Exists",
      fg: Theme.warning,
    })
  );
  modal.add(new TextRenderable(renderer, { content: "" }));

  // Info
  modal.add(
    new TextRenderable(renderer, {
      content: `Card #${card.number}`,
      fg: Theme.text,
    })
  );
  modal.add(
    new TextRenderable(renderer, {
      content: existingPath.replace(process.env.HOME || "", "~"),
      fg: Theme.muted,
    })
  );
  modal.add(new TextRenderable(renderer, { content: "" }));

  // Button group
  let selectedIndex = 0;
  const buttonGroup = createButtonGroup(renderer, [
    { label: "Cancel" },
    { label: "Recreate", selectedBg: Theme.warning, selectedBorder: Theme.warning },
  ]);
  modal.add(buttonGroup.container);

  // Key handler
  const keyHandler = (key: { name?: string }) => {
    if (currentView !== "confirm" || isTransitioning) return;
    
    if (key.name === "left" || key.name === "right" || key.name === "h" || key.name === "l" || key.name === "tab") {
      selectedIndex = selectedIndex === 0 ? 1 : 0;
      buttonGroup.updateSelection(selectedIndex);
    } else if (key.name === "return" || key.name === "enter") {
      renderer.keyInput.off("keypress", keyHandler);
      if (selectedIndex === 1) {
        try {
          git.removeWorktree(branchName);
          git.createWorktree(branchName);
        } catch {
          // Ignore errors
        }
      }
      transitionToView(() => showMainView(renderer));
    } else if (key.name === "escape") {
      renderer.keyInput.off("keypress", keyHandler);
      transitionToView(() => showMainView(renderer));
    }
  };
  renderer.keyInput.on("keypress", keyHandler);

  // Status
  modal.add(new TextRenderable(renderer, { content: "" }));
  modal.add(
    new TextRenderable(renderer, {
      content: "←/→ select  enter confirm  esc cancel",
      fg: Theme.muted,
    })
  );

  container.add(modal);
  root.add(container);
}

function showSwitchWithContextPrompt(
  renderer: CliRenderer,
  worktreePath: string,
  card: FizzyCard,
  cardNumber: number,
  newWindow: boolean = false
) {
  currentView = "switch-confirm";
  const root = renderer.root;
  clearChildren(root);

  // Options
  type ContextOption = { type: "with-context" } | { type: "without-context" } | { type: "back" };
  const items: ContextOption[] = [
    { type: "with-context" },
    { type: "without-context" },
    { type: "back" },
  ];

  // Create centered container
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Theme.transparent,
  });

  // Modal-style box
  const modal = new BoxRenderable(renderer, {
    width: 55,
    flexDirection: "column",
    backgroundColor: Theme.backgroundSubtle,
    border: true,
    borderColor: Theme.muted,
    borderStyle: "rounded",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });

  // Header
  const headerRow = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: Theme.transparent,
    marginBottom: 1,
  });
  headerRow.add(new TextRenderable(renderer, {
    content: "Fizzy Card Detected",
    fg: Theme.accent,
  }));
  headerRow.add(new TextRenderable(renderer, {
    content: git.repoName(),
    fg: Theme.muted,
  }));
  modal.add(headerRow);

  // Card tile - same style as list view
  const cardTile = createCardTile(renderer, {
    card: { ...card, number: cardNumber },
    selected: true,
    width: "100%",
  });
  modal.add(cardTile);
  modal.add(new TextRenderable(renderer, { content: "" }));

  // Container for option tiles
  const tilesContainer = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    backgroundColor: Theme.transparent,
  });
  modal.add(tilesContainer);

  // Selection state
  let selectedIndex = 0;
  const tiles: BoxRenderable[] = [];

  // Track if user wants context
  const getIncludeContext = () => items[selectedIndex].type === "with-context";

  // Create a tile for an option
  const createOptionTile = (item: ContextOption, selected: boolean): BoxRenderable => {
    if (item.type === "with-context") {
      const tile = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "column",
        border: true,
        borderColor: selected ? Theme.accent : Theme.muted,
        borderStyle: "rounded",
        backgroundColor: Theme.transparent,
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
      });
      tile.add(new TextRenderable(renderer, {
        content: "\uf075  With card context",  // nf-fa-comment
        fg: selected ? Theme.textBright : Theme.text,
      }));
      tile.add(new TextRenderable(renderer, {
        content: "Include card details in OpenCode prompt",
        fg: Theme.muted,
      }));
      return tile;
    } else if (item.type === "without-context") {
      const tile = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "column",
        border: true,
        borderColor: selected ? Theme.accent : Theme.muted,
        borderStyle: "rounded",
        backgroundColor: Theme.transparent,
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
      });
      tile.add(new TextRenderable(renderer, {
        content: "\uf054  Without context",  // nf-fa-chevron_right
        fg: selected ? Theme.textBright : Theme.text,
      }));
      tile.add(new TextRenderable(renderer, {
        content: "Just open the worktree",
        fg: Theme.muted,
      }));
      return tile;
    } else {
      const tile = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "row",
        border: true,
        borderColor: selected ? Theme.accent : Theme.muted,
        borderStyle: "rounded",
        backgroundColor: Theme.transparent,
        paddingLeft: 1,
        paddingRight: 1,
      });
      tile.add(new TextRenderable(renderer, {
        content: "\u2190 Back",
        fg: selected ? Theme.accent : Theme.muted,
      }));
      return tile;
    }
  };

  // Build tiles
  let isRebuilding = false;
  const rebuildTiles = () => {
    if (isRebuilding) return;
    isRebuilding = true;
    
    for (const tile of tiles) {
      tilesContainer.remove(tile.id);
      tile.destroyRecursively();
    }
    tiles.length = 0;

    items.forEach((item, index) => {
      const tile = createOptionTile(item, index === selectedIndex);
      tiles.push(tile);
      tilesContainer.add(tile);
    });
    
    isRebuilding = false;
  };

  rebuildTiles();

  // Status bar
  modal.add(new TextRenderable(renderer, { content: "" }));
  modal.add(new TextRenderable(renderer, {
    content: "j/k navigate  enter confirm  esc back",
    fg: Theme.muted,
  }));

  container.add(modal);
  root.add(container);

  // Key handler
  const keyHandler = (key: { name?: string; shift?: boolean }) => {
    if (currentView !== "switch-confirm" || isTransitioning) return;

    const keyNewWindow = key.shift === true;

    if (key.name === "j" || key.name === "down") {
      if (selectedIndex < items.length - 1) {
        selectedIndex++;
        rebuildTiles();
      }
    } else if (key.name === "k" || key.name === "up") {
      if (selectedIndex > 0) {
        selectedIndex--;
        rebuildTiles();
      }
    } else if (key.name === "return" || key.name === "enter") {
      renderer.keyInput.off("keypress", keyHandler);
      const item = items[selectedIndex];

      transitionToView(() => {
        if (item.type === "back") {
          showMainView(renderer);
        } else {
          const prompt = getIncludeContext() ? fizzy.generateInitialPrompt(card, cardNumber) : undefined;
          if (newWindow) {
            launchOpenCodeInNewWindow(renderer, worktreePath, prompt);
            showMainView(renderer);
          } else {
            launchOpenCode(renderer, worktreePath, prompt);
          }
        }
      });
    } else if (key.name === "escape") {
      renderer.keyInput.off("keypress", keyHandler);
      transitionToView(() => showMainView(renderer));
    } else if (key.name === "o" || key.name === "O") {
      const prompt = getIncludeContext() ? fizzy.generateInitialPrompt(card, cardNumber) : undefined;
      if (keyNewWindow) {
        launchOpenCodeInNewWindow(renderer, worktreePath, prompt);
        renderer.keyInput.off("keypress", keyHandler);
        showMainView(renderer);
      } else {
        renderer.keyInput.off("keypress", keyHandler);
        launchOpenCode(renderer, worktreePath, prompt);
      }
    } else if (key.name === "n" || key.name === "N") {
      if (keyNewWindow) {
        launchNvim(renderer, worktreePath);
        renderer.keyInput.off("keypress", keyHandler);
        showMainView(renderer);
      } else {
        renderer.keyInput.off("keypress", keyHandler);
        launchNvimInPlace(renderer, worktreePath);
      }
    } else if (key.name === "t" || key.name === "T") {
      if (keyNewWindow) {
        launchTerminal(renderer, worktreePath);
        renderer.keyInput.off("keypress", keyHandler);
        showMainView(renderer);
      } else {
        renderer.keyInput.off("keypress", keyHandler);
        launchShellInPlace(renderer, worktreePath);
      }
    }
  };
  renderer.keyInput.on("keypress", keyHandler);
}

function launchOpenCode(renderer: CliRenderer, path: string, prompt?: string) {
  // Build command
  const model = "anthropic/claude-opus-4-5";
  let cmd = `opencode -m ${model}`;
  
  // Add prompt if provided
  if (prompt) {
    const escapedPrompt = terminal.escapePath(prompt);
    cmd += ` --prompt '${escapedPrompt}'`;
  }

  terminal.runInPlace(path, cmd, () => renderer.destroy());
}

// Launch opencode in a new terminal window (doesn't take over current window)
function launchOpenCodeInNewWindow(_renderer: CliRenderer, path: string, prompt?: string) {
  // Build opencode command
  const model = "anthropic/claude-opus-4-5";
  let opencodeCmd = `opencode -m ${model}`;
  if (prompt) {
    const escapedPrompt = terminal.escapePath(prompt);
    opencodeCmd += ` --prompt '${escapedPrompt}'`;
  }

  terminal.openTerminalWindow({ path, command: opencodeCmd });
  // Stay on current view
}

// Launch nvim in place (takes over current window)
function launchNvimInPlace(renderer: CliRenderer, path: string) {
  terminal.runInPlace(path, "nvim .", () => renderer.destroy());
}

// Launch shell in place (takes over current window)
function launchShellInPlace(renderer: CliRenderer, path: string) {
  terminal.openShellInPlace(path, () => renderer.destroy());
}

// Launch nvim in a new terminal window (doesn't take over current window)
function launchNvim(_renderer: CliRenderer, path: string) {
  terminal.openTerminalWindow({ path, command: "nvim ." });
  // Stay on current view - don't navigate away
}

function launchTerminal(_renderer: CliRenderer, path: string) {
  terminal.openTerminalWindow({ path });
  // Stay on current view - don't navigate away
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
