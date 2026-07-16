/*
 * Proves the isolated-vm sandbox is real — run in CI and inside the action image.
 *
 * Why this exists: a green `npm ci` proves nothing useful about the sandbox. The
 * native addon resolves from a prebuilt binary in seconds without compiling, and
 * npm 11.16 only *warns* about unapproved install scripts today (it will block
 * them in a future release). Either way the failure is silent: the image builds,
 * CI goes green, and the action dies at runtime on the first PR — or worse, the
 * isolate exists but leaks the host.
 *
 * isolated-vm is the product's security boundary (ADR 0001 / CL-21), so assert
 * the two things that must hold: the isolate executes code, and it cannot reach
 * the host. CommonJS (.cjs) because isolated-vm is CJS and the package is ESM.
 */

const assert = require("node:assert/strict");
const ivm = require("isolated-vm");

const MEMORY_LIMIT_MB = 16;

function main() {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  try {
    const context = isolate.createContextSync();

    // 1. The isolate executes code and returns a real value.
    const sum = context.evalSync("40 + 2");
    assert.equal(sum, 42, `isolate returned ${sum} instead of 42`);

    // 2. The isolate cannot reach the host. These are the escapes that would
    //    make the whole "safe to run untrusted PR code" claim false.
    for (const hostGlobal of ["process", "require", "globalThis.process"]) {
      const kind = context.evalSync(`typeof ${hostGlobal}`);
      assert.equal(kind, "undefined", `sandbox leaked host global: ${hostGlobal}`);
    }

    console.log(
      `isolated-vm ${require("isolated-vm/package.json").version} ok on node ${process.version}: ` +
        `isolate evaluated 40 + 2 = ${sum}, host globals unreachable`,
    );
  } finally {
    isolate.dispose();
  }
}

main();
