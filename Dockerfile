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
# `npm ci` resolves the isolated-vm binary here, once, at image build.
COPY package.json package-lock.json* ./
RUN npm ci

# Fail the image build if the sandbox is not real. `npm ci` exiting 0 does not
# prove it: the addon resolves from a prebuilt binary without compiling, and npm
# 11.16 only warns about unapproved install scripts. Without this gate a broken
# image ships green and dies on the first PR it runs against.
COPY scripts ./scripts
RUN node scripts/verify-sandbox.cjs

# Copy the rest of the source and build TS -> dist/.
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
RUN npm run build

# The Action entrypoint. GitHub mounts the workspace and passes inputs as env vars.
ENTRYPOINT ["node", "/action/dist/action.js"]
