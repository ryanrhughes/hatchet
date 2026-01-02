# Hatchet Development Guide

This document contains important patterns and conventions for developing the `hatchet` TUI application.

## Project Structure

- `src/main.ts` - Main application with all views
- `src/helpers/git.ts` - Git worktree operations
- `src/helpers/fizzy.ts` - Fizzy (task management) integration
- `src/helpers/html.ts` - HTML to TUI rendering
- `src/helpers/image.ts` - Image extraction and placeholders
- `src/helpers/terminal.ts` - Terminal launcher utilities
- `src/helpers/card-tile.ts` - Fizzy card tile component
- `src/theme.ts` - Color theming system
- `src/types.ts` - TypeScript type definitions

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
# Run the app
bun hatchet

# Type check (ignore known issues in unused files)
npx tsc --noEmit 2>&1 | grep -v "src/app.ts\|src/views/"

# Toggle console for debugging (in app)
Press ` (backtick)
```
