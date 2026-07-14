# 🔍 CodeLens

**Passing tests give you confidence. They don't give you comprehension.**

When an AI agent (Claude Code, Cursor, Devin) opens a PR, tests pass and CI goes green — but the human reviewer often doesn't actually understand what the code *does*. They rubber-stamp it. Over time the team loses the mental model of its own codebase.

CodeLens is an independent AI agent that runs on every PR. It does **not** read your existing tests. Instead it generates its own inputs from the types, **actually executes the changed code in a sandbox**, captures real intermediate values, and posts a plain-English execution trace as a PR comment — *before* anyone reviews the diff.

The goal is one thing: **comprehension**. So a human reviewing AI-written code understands why it behaves the way it does, instead of trusting that green CI means "correct."

---

## What it does

On each PR, CodeLens spins up an independent agent that:

- **Ignores the existing test suite** — it forms its own view, so it can't be fooled by tests that assert the wrong thing.
- **Generates its own inputs** from the TypeScript/Python types — happy path, empty, null, boundary, and the cases the author probably didn't think about.
- **Actually executes the changed functions** in an isolated sandbox.
- **Captures real intermediate values** at key points — observed, not inferred.
- **Reconstructs the implicit contract** — what the code *really* expects, and the likely reason it's built that way (inferred from behavior, never claimed as fact).
- **Posts a plain-English trace** as a PR comment before the human reviews.

It follows strict honesty rules: it never calls something a bug unless execution confirmed a failure, never invents intermediate values, and says so explicitly when it couldn't run something.

## Supported languages

**Phase 1 (current)**
- **TypeScript / Node.js** — executed in an [`isolated-vm`](https://github.com/laverdet/isolated-vm) V8 sandbox
- **Python** — executed via a `child_process` subprocess

**Phase 2 (planned)**
- **React (`.tsx`)** — rendered in Playwright + jsdom, visual state captured per prop combination
- **HTML** — rendered headless in Playwright, visual snapshots captured

Language is routed by file extension:

| Extension | Executor |
|---|---|
| `.ts` / `.js` (no JSX) | TypeScript (isolated-vm) |
| `.py` | Python (subprocess) |
| `.tsx` / `.jsx` | React *(Phase 2)* |
| `.html` | HTML *(Phase 2)* |

## Phase 1 scope

- Pure functions and React hooks only — no DB calls, no network in the executor.
- Functions with unfixable side effects are marked `skipped`; the narrator still runs statically.
- The report is **never** skipped entirely — CodeLens always posts something.
- Exactly **two model calls per PR**: one to generate inputs, one to narrate results.

---

## How it works

```
PR opened / updated
   │
   ▼
diff-parser      → extract changed function bodies
type-extractor   → ts-morph resolves their types
input-generator  → Claude call #1: synthetic input scenarios
   │
   ▼
executor         → run each scenario in the sandbox,
                   capture output + intermediate values
   │
   ▼
narrator         → Claude call #2: plain-English execution trace
   │
   ▼
comment-poster   → post the report as a PR comment
```

## Model backends

The two Claude calls go through a single swappable seam, selected by the `CODELENS_LLM` env var / `llm-backend` action input:

| Backend | Auth | Cost | Use for |
|---|---|---|---|
| `cli` | Claude CLI OAuth token (`claude setup-token`) | Your subscription — **$0 API** | Local dev; your own repos |
| `sdk` | `ANTHROPIC_API_KEY` | Per token | Public installs (each user brings their own key) |
| `mock` | none | Free / offline | Unit tests |

## Usage

### As a GitHub Action

```yaml
# .github/workflows/codelens.yml
name: CodeLens
on:
  pull_request:

jobs:
  codelens:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./ # or your-org/codelens@v1
        with:
          llm-backend: sdk
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

> To run it on your subscription instead of a per-token API key, set `llm-backend: cli` and pass `claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.

### Locally (CLI)

```bash
CODELENS_LLM=cli npx codelens --diff ./diff.txt --repo owner/repo --pr 42
```

## Development

```bash
npm install      # note: compiles the native isolated-vm module
npm run build    # tsc → dist/
npm test         # vitest
npm run typecheck
```

Requires **Node.js 20+**.

## Roadmap

- **Phase 1** — TypeScript + Python execution, independent narrated report on every PR *(in progress)*
- **Merge-time learning** *(under consideration)* — on merge, write confirmed Evals to `__codelens__/evals/` and load-bearing rules to `CLAUDE.md`, so the next agent inherits the knowledge
- **Phase 2** — React `.tsx` and HTML visual capture via Playwright

## License

MIT — see [LICENSE](./LICENSE).
