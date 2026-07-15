import { defineConfig } from "vitest/config";

// Test harness for CodeLens (CL-19). Unit tests run offline — no network, no
// isolated-vm native build required for the non-executor modules. The `mock` LLM
// backend (CL-9) keeps model-dependent code deterministic here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // Start modest; tighten as core/ and the adapters land.
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
