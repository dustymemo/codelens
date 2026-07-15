# ADR 0001 — Action packaging for the native `isolated-vm` addon

- **Status:** Accepted (pending review)
- **Ticket:** CL-21
- **Date:** 2026-07-15
- **Deciders:** CodeLens maintainers

## Context

CodeLens ships as a GitHub Action. Its executor runs untrusted PR code inside an
[`isolated-vm`](https://github.com/laverdet/isolated-vm) V8 isolate. Two facts about the
project drive this decision:

1. **`isolated-vm` is a native addon** — it needs a C++ binary compiled for the runner's
   OS + CPU arch + Node ABI. It cannot be bundled into a single JS file.
2. **CodeLens executes untrusted code** — the whole point of the tool.

The scaffold's `action.yml` currently declares a `node20` JavaScript action running
`dist/action.js`. That is a false start: a `node20` action runs the **committed** code
as-is — GitHub does **not** run `npm install` on the runner — so the native binary would
be absent, and `dist/` is git-ignored anyway. We must pick how the code + native binary
actually reach the runner.

### Where the sandboxing really happens

It is worth being precise, because it shapes the trade-off. The **real** sandbox is the
V8 isolate provided by `isolated-vm`. Packaging (this ADR) does **not** sandbox anything
by itself — it only decides how CodeLens and its native binary are delivered. Docker's
container boundary is a *secondary* wall around the isolate, not the primary one.

```
GitHub runner (VM)
└── [packaging decides this layer] CodeLens app  (Node + isolated-vm binary)
    └── V8 isolate  ← the actual sandbox where untrusted PR code runs
```

## Options considered

### (A) Docker action — **chosen**
A `Dockerfile` pins Node + OS + build tools + the compiled `isolated-vm` together. For
dev, GitHub builds the image on the runner; for release, we publish it to GHCR and the
action pulls it.

- ➕ Hermetic & reproducible — binary and its ABI/OS are locked into the image.
- ➕ Native compile happens once (at image build/publish), not smeared across every run.
- ➕ An OS-level **container boundary around the isolate** — defense-in-depth for a tool
  whose job is running hostile code.
- ➖ Linux-only (acceptable; our runners are `ubuntu-latest`).
- ➖ Cold start: building the image per run is slow. Mitigation: publish to GHCR and
  reference the image (`image: docker://ghcr.io/...`) so runs *pull* instead of *build*.
- ➖ Extra moving part: an image-publish workflow (deferred to release).

### (B) Composite action — strong runner-up
`checkout → setup-node → npm ci → build → node dist/action.js`, in the consumer's job.

- ➕ Fresh native build matching the exact runner; no ABI/arch guessing; no committed
  binaries; simplest to author.
- ➖ Pays `npm ci` every run; we don't control the consumer's cache.
- ➖ Depends on the consumer's runner having the needed toolchain.
- ➖ Runs **bare on the consumer's runner, next to the untrusted PR code** — no isolation
  beyond the V8 isolate.

### (C) Commit `dist/` + prebuilt binary — rejected
Build locally, commit the output so the `node20` action runs it as-is.

- ➖ The bundler cannot inline a `.node` file, so this means committing
  `node_modules/isolated-vm` (a binary blob) — heavy, brittle, ugly diffs.
- ➖ Committed binary must match the runner's Node ABI/arch; a Node bump breaks it
  silently.
- ➕ Only upside is fastest cold start. Not worth the fragility.

## Decision

Adopt **(A) Docker action**.

The deciding factor is that CodeLens's two driving facts point the same way only here:
Docker pins the **native binary** reproducibly *and* gives the **untrusted code** an
OS-level wall around the isolate. (B) and (C) offer nothing beyond the isolate.

If CodeLens were not a security-sensitive sandbox, **(B) composite would be the right
call** — simpler, no image pipeline. Our recommendation rests specifically on the
untrusted-code threat model. Revisit this ADR if that assumption changes.

### Rollout

1. **Now (dev):** `action.yml` uses `image: 'Dockerfile'` — GitHub builds on the runner.
   Simplest; nothing to publish; works immediately for CI (CL-19) and testing.
2. **At v1 release:** add a publish workflow that pushes the image to GHCR and switch
   `action.yml` to `image: 'docker://ghcr.io/<org>/codelens:v1'` for fast pulls. Same
   Dockerfile; only build-vs-pull changes.

### Consequences

- CI (CL-19) must build the **same Dockerfile**, so "green in CI" matches production.
- The TS executor (CL-7) can assume a fixed Linux + Node environment with the binary
  present — no runtime environment probing.
- `dist/` stays git-ignored (built inside the image, never committed).
- macOS/Windows runners are unsupported (not a Phase 1 requirement).

### Local development & validation

- **The Docker image is validated in CI, not locally.** GitHub-hosted runners ship with
  Docker; a contributor's machine may not (e.g. the current Windows dev box has no Docker
  installed). This is fine — the packaged action only needs Docker on the runner. Note
  that a composite action would be no more locally verifiable: both approaches ultimately
  only run for real on GitHub's Linux runners.
- **Most development needs neither Docker nor a local native build.** Run `vitest` + `node`
  directly. With the `mock` LLM backend (CL-9) and by exercising the non-executor modules
  (diff parser, type extractor, narrator, comment poster), contributors avoid compiling
  `isolated-vm` locally (which on Windows needs VS Build Tools + Python).
- **Exercising the real isolate locally** requires either Docker Desktop or a local native
  build toolchain. When neither is available, rely on CI to cover the executor path.
