#!/bin/bash
# Install Hatchet as protocol handler for hatchet:// URLs (Linux only)
#
# This allows links like:
#   hatchet://card/123?path=/home/user/project
#   hatchet://card/123?path=/home/user/project&open=true
#   hatchet://card/123?path=/home/user/project&open=true&context=true
#
# To trigger Hatchet from the browser.

set -e

echo "Installing Hatchet protocol handler..."
echo ""

# Find hatchet executable
HATCHET_PATH=""

if command -v hatchet &> /dev/null; then
    HATCHET_PATH=$(which hatchet)
elif [ -x "$HOME/.bun/bin/hatchet" ]; then
    HATCHET_PATH="$HOME/.bun/bin/hatchet"
elif [ -x "./src/main.ts" ]; then
    # Development: use bun to run the script directly
    HATCHET_PATH="$(pwd)/src/main.ts"
    echo "Note: Using development path. For production, run 'bun link' first."
fi

if [ -z "$HATCHET_PATH" ]; then
    echo "Error: hatchet not found!"
    echo ""
    echo "Please install hatchet first:"
    echo "  cd /path/to/hatchet"
    echo "  bun link"
    echo ""
    echo "Or ensure it's in your PATH."
    exit 1
fi

echo "Found hatchet at: $HATCHET_PATH"

DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/hatchet-handler.desktop"

# Ensure directory exists
mkdir -p "$DESKTOP_DIR"

# Install wrapper script to ~/.local/bin
WRAPPER_DIR="$HOME/.local/bin"
WRAPPER_PATH="$WRAPPER_DIR/hatchet-protocol-wrapper"
mkdir -p "$WRAPPER_DIR"

# Determine the hatchet command
if [[ "$HATCHET_PATH" == *.ts ]]; then
    HATCHET_CMD="bun $HATCHET_PATH"
else
    HATCHET_CMD="$HATCHET_PATH"
fi

# Create wrapper script that runs hatchet then drops to shell
cat > "$WRAPPER_PATH" << EOF
#!/bin/bash
# Wrapper script for hatchet protocol handler
# Runs hatchet with the URL, then drops to a shell so the terminal stays open
$HATCHET_CMD --url "\$1"
exec bash
EOF
chmod +x "$WRAPPER_PATH"

echo "Created wrapper script: $WRAPPER_PATH"

# Create .desktop file using the wrapper
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Hatchet Protocol Handler
Comment=Git Worktree Manager - Protocol Handler for hatchet:// URLs
Exec=xdg-terminal-exec -- $WRAPPER_PATH %u
Type=Application
MimeType=x-scheme-handler/hatchet;
NoDisplay=true
Terminal=false
Categories=Development;
EOF

echo "Created desktop file: $DESKTOP_FILE"

# Register as handler
xdg-mime default hatchet-handler.desktop x-scheme-handler/hatchet

echo ""
echo "Hatchet protocol handler installed successfully!"
echo ""
echo "Usage:"
echo "  hatchet://card/<number>?path=<repo-path>"
echo "  hatchet://card/<number>?path=<repo-path>&launch-ai=true"
echo "  hatchet://card/<number>?path=<repo-path>&launch-ai=true&with-context=true"
echo ""
echo "Test with:"
echo "  xdg-open 'hatchet://card/123?path=$(pwd)'"
echo ""
