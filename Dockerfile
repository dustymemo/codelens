# CodeLens GitHub Action — Docker packaging (ADR 0001 / CL-21)
#
# Why Docker: isolated-vm is a native addon that must be compiled for the runner.
# Building it into the image gives a reproducible binary AND an OS-level container
# wall around the V8 isolate that executes untrusted PR code.

# Pin Node 20 (matches engines ">=20" and the original action.yml intent).
FROM node:20-bookworm-slim

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
