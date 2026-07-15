import { describe, expect, it } from "vitest";

import { detectLanguage } from "./lang-detector.js";

describe("detectLanguage", () => {
  it.each([
    ["src/util.ts", "typescript", true],
    ["index.js", "typescript", true],
    ["esm/mod.mjs", "typescript", true],
    ["legacy/mod.cjs", "typescript", true],
    ["scripts/build.py", "python", true],
  ])("routes executable Phase 1 file %s → %s", (path, language, supported) => {
    expect(detectLanguage(path)).toEqual({ language, supported });
  });

  it.each([
    ["components/Button.tsx", "react"],
    ["widget.jsx", "react"],
    ["public/index.html", "html"],
    ["page.htm", "html"],
  ])("detects Phase 2 file %s → %s but marks it unsupported", (path, language) => {
    expect(detectLanguage(path)).toEqual({ language, supported: false });
  });

  it("is case-insensitive on the extension", () => {
    expect(detectLanguage("Foo.TS")).toEqual({ language: "typescript", supported: true });
    expect(detectLanguage("Bar.PY")).toEqual({ language: "python", supported: true });
  });

  it("uses the basename so directory dots don't interfere", () => {
    expect(detectLanguage("my.dir/v1.2/app.ts")).toEqual({
      language: "typescript",
      supported: true,
    });
  });

  it("handles multi-dot filenames by the final extension", () => {
    expect(detectLanguage("component.test.ts")).toEqual({
      language: "typescript",
      supported: true,
    });
  });

  it("handles Windows-style backslash paths", () => {
    expect(detectLanguage("src\\nested\\app.ts")).toEqual({
      language: "typescript",
      supported: true,
    });
  });

  it.each([
    ["README.md"],
    ["notes.txt"],
    ["archive.tar.gz"],
    ["Makefile"],
    [".gitignore"],
    [""],
    ["trailingdot."],
  ])("returns null for unrecognized / extension-less %s", (path) => {
    expect(detectLanguage(path)).toBeNull();
  });
});
