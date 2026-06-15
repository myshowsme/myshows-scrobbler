# syntax=docker/dockerfile:1.7

# ── Build stage ─────────────────────────────────────────────────────────────
# Full toolchain — installs dev deps, runs vite-plus to compile the server
# and the UI into /app/dist.
FROM node:22-alpine AS builder

WORKDIR /app

# libstdc++ is required for native modules (koffi prebuilds on alpine).
RUN apk add --no-cache libstdc++ \
  && npm install -g vite-plus@0.1.19

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile

# Source files for the build. .dockerignore filters out tests, fixtures,
# docs, .git, etc. so we don't bloat the layer.
COPY . .

RUN vp run build:all

# ── Runtime stage ───────────────────────────────────────────────────────────
# Lean image — only what's needed to run `node dist/server/index.mjs`. No
# vite-plus, no source tree.
FROM node:22-alpine

WORKDIR /app

# NODE_ENV gates dev-only routes (Tester / fixtures API) off at runtime.
# Without this, those routes would register because the server's check is
# `process.env.NODE_ENV !== 'production'`. Pinning here is the single most
# important security setting in this file.
ENV NODE_ENV=production
# Sane defaults; can be overridden via `docker run -e`.
ENV PORT=3000
ENV ENABLE_UI=true
ENV CONFIG_PATH=/data/config.json

RUN apk add --no-cache libstdc++ tini

# Non-root user owns the app dir and the /data volume mount point.
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && mkdir -p /data \
  && chown nodejs:nodejs /data

# Production deps only — dev deps were used in the builder stage and stay
# there. We also drop the global vite-plus install: the runtime just calls
# `node`, not `vp`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g vite-plus@0.1.19 \
  && vp install --frozen-lockfile --prod \
  && npm uninstall -g vite-plus \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Runtime probes spawn PowerShell / osascript scripts. Only macos-osa-probe.js
# is exercised on the platforms this image runs on, but copying the whole
# scripts dir keeps path resolution behaviour identical to a bare-metal install.
COPY --from=builder /app/scripts ./scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/health" >/dev/null 2>&1 || exit 1

# tini reaps zombies and forwards SIGTERM correctly to Node — without it,
# `docker stop` waits the full 10s grace period before killing.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
