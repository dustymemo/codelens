# CodeLens GitHub Action — Docker packaging (ADR 0001 / CL-21)
#
# Why Docker: isolated-vm is a native addon that must be compiled for the runner.
# Building it into the image gives a reproducible binary AND an OS-level container
# wall around the V8 isolate that executes untrusted PR code.

# Pin Node 24, the Active LTS (security support to 2028-04-30) — matches
# engines ">=24". Node 20 was dropped when it reached EOL on 2026-04-30; an
# unpatched runtime is untenable for a tool that executes untrusted PR code.
# The pin is coupled to isolated-vm: 6.x requires Node >=22, 7.x requires >=26.
FROM node:24-bookworm-slim

# Build toolchain required to compile the native isolated-vm addon.
# Kept in a single layer and cleaned up to keep the image small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /action

# Install deps first (better layer caching). Copy manifests, then install.
# `npm ci` compiles/fetches the isolated-vm binary here, once, at image build.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the source and build TS -> dist/.
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
RUN npm run build

# The Action entrypoint. GitHub mounts the workspace and passes inputs as env vars.
ENTRYPOINT ["node", "/action/dist/action.js"]
