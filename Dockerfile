# Stage 1: Builder - install dependencies
FROM python:3.12-slim AS builder

WORKDIR /build

# Create virtual environment for clean copying
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# Stage 2: Final image with Xvfb for thumbnail rendering
FROM python:3.12-slim

WORKDIR /app

# Install Xvfb, OpenGL, and PyMeshLab dependencies for server-side rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libgl1 \
    libglu1-mesa \
    libglx-mesa0 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    libxcb-xinerama0 \
    libxkbcommon0 \
    libxcb-cursor0 \
    libxcb-icccm4 \
    libxcb-keysyms1 \
    libxcb-shape0 \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set up virtual display for trimesh rendering
ENV DISPLAY=:99
# PyMeshLab headless mode
ENV QT_QPA_PLATFORM=offscreen

# Copy application code
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY styles/ ./styles/
COPY huggingface-moge2/ ./huggingface-moge2/
COPY index.html .

# Create data directories and X11 socket directory
RUN mkdir -p /app/server/data /app/server/storage /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix

# Non-root user for security
RUN useradd --create-home --shell /bin/bash appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Start Xvfb in background, then uvicorn
CMD Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset & \
    sleep 1 && \
    uvicorn server.main:app --host 0.0.0.0 --port 8000
