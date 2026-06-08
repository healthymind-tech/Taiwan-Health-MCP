# ── builder stage ────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build
COPY requirements.txt .

# git  — required for pip install from GitHub (dots_ocr)
# build-essential, libcairo2-dev, pkg-config — required by cairosvg (dots_ocr dep)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    libcairo2-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# dots_ocr — the upstream repo is missing dots_ocr/model/__init__.py so
# find_packages() omits it.  Clone, patch, then install manually.
RUN git clone --depth=1 https://github.com/rednote-hilab/dots.ocr.git /tmp/dots_ocr \
    && touch /tmp/dots_ocr/dots_ocr/model/__init__.py \
    && pip install --no-cache-dir --prefix=/install /tmp/dots_ocr \
    && rm -rf /tmp/dots_ocr


# ── frontend stage (admin SPA) ────────────────────────────────────────────────
# Builds admin-ui/dist, served by the Python app at /admin when ADMIN_UI=spa.
FROM node:22-slim AS frontend

WORKDIR /ui
COPY admin-ui/package.json admin-ui/package-lock.json ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build


# ── runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12-slim

# Non-root user
RUN groupadd -r mcp && useradd -r -g mcp -d /app -s /sbin/nologin mcp

# libcairo2 — runtime shared library needed by cairosvg (dots_ocr dep)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application source
COPY src/ ./src/
COPY loader/ ./loader/

# Copy static assets
COPY static/ ./static/

# Copy the built admin SPA (served at /admin when ADMIN_UI=spa)
COPY --from=frontend /ui/dist ./admin-ui/dist

RUN chown -R mcp:mcp /app

USER mcp

ENV PYTHONUNBUFFERED=1

WORKDIR /app/src

ENTRYPOINT ["python", "server.py"]
