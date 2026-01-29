#!/bin/bash
# Setup script for RoomDesigner MoGe-2 Modal deployment
# Run this from the RoomDesigner directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$SCRIPT_DIR/venv"
MODAL="$VENV_DIR/bin/modal"
PIP="$VENV_DIR/bin/pip"

echo "=== RoomDesigner MoGe-2 Modal Setup ==="

# Create virtual environment if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Install modal
echo "Installing Modal CLI..."
"$PIP" install --upgrade pip
"$PIP" install modal

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Modal CLI installed at: $MODAL"
echo ""
echo "Next steps:"
echo ""
echo "1. Authenticate with Modal (one-time, opens browser):"
echo "   $MODAL token new"
echo ""
echo "2. Deploy MoGe-2 endpoint:"
echo "   $MODAL deploy $SCRIPT_DIR/moge2_endpoint.py"
echo ""
echo "3. (Optional) Deploy LBM relighting endpoint:"
echo "   $MODAL deploy $SCRIPT_DIR/lbm_endpoint.py"
echo ""
echo "4. Copy the endpoint URLs from the output and add to .env:"
echo "   MOGE2_MODAL_ENDPOINT=https://your-workspace--roomdesigner-moge2-moge2inference-process-image.modal.run"
echo "   LBM_MODAL_ENDPOINT=https://your-workspace--roomdesigner-lbm-lbmrelighting-relight.modal.run"
echo ""
echo "5. Rebuild RoomDesigner container:"
echo "   cd $PROJECT_DIR && docker-compose up -d --build"
echo ""
echo "To test locally before deploying:"
echo "   $MODAL run $SCRIPT_DIR/moge2_endpoint.py assets/IMG_0940.JPEG"
echo ""
