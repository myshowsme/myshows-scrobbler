# syntax=docker/dockerfile:1.7

# ── Build stage ─────────────────────────────────────────────────────────────
# Full toolchain — installs dev deps, runs vite-plus to compile the server
# and the UI into /app/dist.
#
# Alpine (musl) base. koffi ships prebuilt .node binaries (@koromix/koffi-*)
# linked against glibc, so on musl it can't load them and its install script
# compiles from source instead — hence cmake/make/g++/python3 here. That musl
# build of koffi is non-functional at runtime, but it never runs: koffi is
# Windows-only (the PotPlayer probe) and src/utils/win32-bridge.ts requires it
# lazily, gated on process.platform === 'win32', so it's never loaded in this
# Linux image. We just need the install to succeed.
FROM node:24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libstdc++ git cmake make g++ python3 \
  && npm install -g vite-plus@0.2.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile

# Source files for the build. .dockerignore filters out tests, fixtures,
# docs, .git, etc. so we don't bloat the layer.
COPY . .

RUN vp run build:all

# ── Prod-deps stage ─────────────────────────────────────────────────────────
# Production node_modules only, built once here so the runtime stage can copy
# them in without carrying the compiler toolchain. Same koffi caveat as above:
# it compiles (uselessly) but is never loaded on Linux.
FROM node:24-alpine AS proddeps

WORKDIR /app

RUN apk add --no-cache libstdc++ git cmake make g++ python3 \
  && npm install -g vite-plus@0.2.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile --prod

# ── Runtime stage ───────────────────────────────────────────────────────────
# Lean image — only what's needed to run `node dist/server/index.mjs`. No
# vite-plus, no compiler toolchain, no source tree.
FROM node:24-alpine

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

# libstdc++ for any native module that needs it; tini reaps zombies / forwards
# signals; wget backs the HEALTHCHECK below.
RUN apk add --no-cache libstdc++ tini wget \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 -G nodejs \
  && mkdir -p /data \
  && chown nodejs:nodejs /data

# Production deps (incl. native binaries) prebuilt in the proddeps stage, plus
# the compiled app and the runtime probe scripts.
COPY --from=proddeps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
