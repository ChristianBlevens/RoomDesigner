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
echo "3. (Optional) Deploy TRELLIS.2 image-to-3D endpoint:"
echo "   $MODAL deploy $SCRIPT_DIR/trellis2_endpoint.py"
echo "   NOTE: First build takes 30-60 min (CUDA compilation, cached after)"
echo "   NOTE: Requires A100 GPU (~\$2.10/hr, ~\$0.005/model)"
echo ""
echo "4. Copy the endpoint URLs from the output and add to .env:"
echo "   MOGE2_MODAL_ENDPOINT=https://your-workspace--roomdesigner-moge2-moge2inference-process-image.modal.run"
echo "   TRELLIS2_ENDPOINT=https://your-workspace--roomdesigner-trellis2-trellis2inference-generate.modal.run"
echo "   MODEL_3D_BACKEND=trellis2  # to use TRELLIS.2 instead of Meshy"
echo ""
echo "5. Rebuild RoomDesigner container:"
echo "   cd $PROJECT_DIR && docker-compose up -d --build"
echo ""
echo "To test locally before deploying:"
echo "   $MODAL run $SCRIPT_DIR/moge2_endpoint.py assets/IMG_0940.JPEG"
echo ""
