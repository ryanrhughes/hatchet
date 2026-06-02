# Hatchet for Fizzy - Chrome Extension

A Chrome extension that adds a Hatchet button to Fizzy card pages, enabling one-click worktree creation and AI harness launch.

## Features

- Adds a Hatchet button to the actions bar on Fizzy card pages
- Automatically detects the board from the back button
- Stores board-to-project-path mappings locally
- Launches `hatchet://` protocol URLs to create worktrees
- Settings popup to manage board configurations

## Installation

### 1. Install the Protocol Handler

First, make sure the Hatchet protocol handler is installed on your system:

```bash
cd /path/to/hatchet
./scripts/install-protocol-handler.sh
```

### 2. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder from the hatchet repository

## Usage

### First Time Setup

1. Navigate to a Fizzy card page (e.g., `https://app.fizzy.do/123456/cards/42`)
2. Click the Hatchet button (axe icon) in the card actions
3. Enter the project path when prompted (e.g., `/home/user/projects/myproject`)
4. The path is saved for that board - future clicks will use it automatically

### Opening a Card

Once configured, clicking the Hatchet button will:

1. Generate a `hatchet://` URL with the card number, project path, and options
2. Trigger the protocol handler
3. Hatchet creates/switches to the worktree for that card
4. Opens the configured AI harness with the card context pre-loaded

### Managing Boards

Click the extension icon in Chrome's toolbar to:

- View all configured boards and their paths
- Edit existing board paths
- Delete board configurations
- Manually add new boards

## URL Format

The extension generates URLs in this format:

```
hatchet://card/<number>?path=<project-path>&launch-ai=true&with-context=true
```

Parameters:
- `card/<number>` - The Fizzy card number
- `path` - Absolute path to the git repository
- `launch-ai=true` - Launch the configured AI harness after creating the worktree
- `with-context=true` - Include card details in the AI prompt

Older `launch-opencode=true` URLs remain supported for compatibility.

## Development

### Files

- `manifest.json` - Extension manifest (Manifest V3)
- `content.js` - Content script injected into Fizzy pages
- `content.css` - Styles for the injected button and modal
- `background.js` - Service worker for storage management
- `popup.html/css/js` - Settings popup UI
- `icons/` - Extension icons (16, 32, 48, 128px)

### Testing

1. Make changes to the extension files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the Hatchet extension
4. Reload the Fizzy page to test changes

## Troubleshooting

### Button doesn't appear

- Make sure you're on a card page (`/cards/<number>`)
- Check the console for errors
- Try refreshing the page

### Protocol handler not working

- Verify the handler is installed: `xdg-mime query default x-scheme-handler/hatchet`
- Test manually: `xdg-open 'hatchet://card/123?path=/tmp'`

### Path prompt keeps appearing

- The board ID might have changed
- Check the popup to see saved boards
- Delete and re-add the board if needed
