import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";

import { extractChangedFunctions } from "./type-extractor.js";

// One Project for the whole file. A Project builds its Program and TypeChecker
// lazily on the first type query — ~66ms, versus ~1ms once it exists — so a
// Project per test paid that toll 18 times over (~7x slower overall).
//
// `strict` is not decoration: without strictNullChecks the checker absorbs `null`
// and `undefined` into their neighbours, so `string | null` resolves to `string`
// and the input-generator would never be told to try null. Real repos we run
// against are strict, so the fixtures must be too.
const project = new Project({
  useInMemoryFileSystem: true,
  compilerOptions: { strict: true },
});

let fixtureCount = 0;

/**
 * Build an in-memory source file, optionally alongside sibling modules it imports.
 *
 * Each fixture gets its own directory so tests sharing the Project cannot collide
 * on `changed.ts` — or on `types.ts`, which two of them define differently.
 */
function sourceOf(code: string, siblings: Record<string, string> = {}): SourceFile {
  const dir = `/fixture${fixtureCount++}`;
  for (const [path, text] of Object.entries(siblings)) {
    project.createSourceFile(`${dir}${path}`, text);
  }
  return project.createSourceFile(`${dir}/changed.ts`, code);
}

/** Every line of the file — "the whole file changed". */
const whole = [{ start: 1, end: 10_000 }];

describe("extractChangedFunctions", () => {
  describe("selecting functions", () => {
    it("returns only functions the changed ranges touch", () => {
      const file = sourceOf(`
export function first(a: number): number {
  return a + 1;
}

export function second(b: number): number {
  return b + 2;
}
`);
      // `second` spans lines 6-8; only touch line 7.
      const found = extractChangedFunctions(file, [{ start: 7, end: 7 }]);
      expect(found.map((f) => f.name)).toEqual(["second"]);
    });

    it("returns nothing when the range touches no function", () => {
      const file = sourceOf(`
const CONSTANT = 1;

export function untouched(): number {
  return CONSTANT;
}
`);
      expect(extractChangedFunctions(file, [{ start: 2, end: 2 }])).toEqual([]);
    });

    it("returns nothing when there are no ranges", () => {
      const file = sourceOf(`export function f(): number { return 1; }`);
      expect(extractChangedFunctions(file, [])).toEqual([]);
    });

    it("reports the enclosing top-level function when a nested helper changes", () => {
      // A nested closure is not independently callable — the executable unit is
      // the top-level function, so that is what must be reported.
      const file = sourceOf(`
export function outer(values: number[]): number[] {
  const double = (n: number): number => {
    return n * 2;
  };
  return values.map(double);
}
`);
      const found = extractChangedFunctions(file, [{ start: 4, end: 4 }]);
      expect(found.map((f) => f.name)).toEqual(["outer"]);
    });

    it("does not report the same function twice for two ranges inside it", () => {
      const file = sourceOf(`
export function once(a: number, b: number): number {
  const x = a + 1;
  const y = b + 2;
  return x + y;
}
`);
      const found = extractChangedFunctions(file, [
        { start: 3, end: 3 },
        { start: 5, end: 5 },
      ]);
      expect(found.map((f) => f.name)).toEqual(["once"]);
    });
  });

  describe("function shape", () => {
    it("extracts a plain exported function", () => {
      const file = sourceOf(`export function add(a: number, b: number): number {
  return a + b;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn).toMatchObject({
        name: "add",
        kind: "function",
        isExported: true,
        isAsync: false,
        returnType: "number",
        parameters: [
          { name: "a", type: "number", optional: false, hasDefault: false },
          { name: "b", type: "number", optional: false, hasDefault: false },
        ],
      });
      expect(fn?.text).toContain("return a + b;");
      expect(fn?.startLine).toBe(1);
    });

    it("flags a non-exported function", () => {
      const file = sourceOf(`function internal(): number { return 1; }`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.isExported).toBe(false);
    });

    it("extracts an async function and its resolved return type", () => {
      const file = sourceOf(`export async function load(id: number): Promise<string> {
  return String(id);
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn).toMatchObject({ name: "load", isAsync: true, returnType: "Promise<string>" });
    });

    it("extracts an arrow function assigned to a const, naming it from the variable", () => {
      const file = sourceOf(`export const triple = (n: number): number => n * 3;`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn).toMatchObject({
        name: "triple",
        kind: "arrow",
        isExported: true,
        returnType: "number",
      });
    });

    it("extracts a class method under a qualified name", () => {
      const file = sourceOf(`export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn).toMatchObject({ name: "Calculator.add", kind: "method" });
    });

    it("infers a return type that was not written", () => {
      const file = sourceOf(`export function implicit(a: number) {
  return a > 0;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.returnType).toBe("boolean");
    });
  });

  describe("parameter types", () => {
    it("marks optional parameters and defaults", () => {
      const file = sourceOf(`export function greet(name: string, loud?: boolean, times = 1): string {
  return name + loud + times;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      // `loud` is reported as plain `boolean` — `optional: true` already carries
      // the undefined, so repeating it in the type is noise for the generator.
      expect(fn?.parameters).toEqual([
        { name: "name", type: "string", optional: false, hasDefault: false },
        { name: "loud", type: "boolean", optional: true, hasDefault: false },
        { name: "times", type: "number", optional: false, hasDefault: true },
      ]);
    });

    it("expands an imported interface into its real shape", () => {
      // The whole point: `User` alone tells the input-generator nothing, and the
      // checker's own text is `import("/types").User`, which leaks a path.
      const file = sourceOf(
        `import type { User } from "./types.js";
export function greet(user: User): string {
  return user.name;
}`,
        { "/types.ts": `export interface User { id: number; name: string; email?: string }` },
      );
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe("{ id: number; name: string; email?: string }");
    });

    it("never leaks an import(...) path into a type", () => {
      const file = sourceOf(
        `import type { User } from "./types.js";
export function pick(user: User): User {
  return user;
}`,
        { "/types.ts": `export interface User { id: number }` },
      );
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).not.toContain("import(");
      expect(fn?.returnType).not.toContain("import(");
    });

    it("expands arrays of objects", () => {
      const file = sourceOf(`interface Point { x: number; y: number }
export function total(points: Point[]): number {
  return points.length;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe("{ x: number; y: number }[]");
    });

    it("keeps unions readable", () => {
      const file = sourceOf(`export function id(v: string | number | null): string {
  return String(v);
}`);
      const [fn] = extractChangedFunctions(file, whole);
      // The checker normalises union order rather than preserving source order.
      expect(fn?.parameters[0]?.type).toBe("null | string | number");
    });

    it("preserves literal union types", () => {
      const file = sourceOf(`export function pick(mode: "fast" | "slow"): string {
  return mode;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe('"fast" | "slow"');
    });

    it("does not explode built-in library types into their methods", () => {
      // Expanding Date would dump ~40 method signatures into the prompt.
      const file = sourceOf(`export function when(d: Date): number {
  return d.getTime();
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe("Date");
    });

    it("keeps a library type opaque even when it is all data", () => {
      // Error is `{ name; message; stack? }` — pure data, but the author did not
      // define it, so its name is what a reader wants.
      const file = sourceOf(`export function describe(e: Error): string {
  return e.message;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe("Error");
    });

    it("expands the repo's own ambient types declared in a .d.ts", () => {
      // Declaration site must not decide this: a hand-written .d.ts holds exactly
      // the domain types the generator most needs the shape of.
      const file = sourceOf(
        `import type { User } from "./ambient.js";
export function greet(user: User): string {
  return user.name;
}`,
        { "/ambient.d.ts": `export interface User { id: number; name: string }` },
      );
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters[0]?.type).toBe("{ id: number; name: string }");
    });

    it("does not leak private class fields into a shape", () => {
      // `secret` is unreachable to a caller, so it is not part of the shape —
      // and once it is gone the class is a method wall, not data.
      const file = sourceOf(`class Repo {
  private secret = 1;
  find(id: number): number { return id + this.secret; }
}
export function lookup(repo: Repo): number {
  return repo.find(1);
}`);
      // The class method is a unit too, so select the function under test.
      const fn = extractChangedFunctions(file, whole).find((f) => f.name === "lookup");
      expect(fn?.parameters[0]?.type).toBe("Repo");
      expect(fn?.parameters[0]?.type).not.toContain("secret");
    });

    it("terminates on a self-referential type instead of recursing forever", () => {
      const file = sourceOf(`interface Node { value: number; next: Node | null }
export function walk(node: Node): number {
  return node.value;
}`);
      const [fn] = extractChangedFunctions(file, whole);
      const type = fn?.parameters[0]?.type ?? "";
      expect(type).toContain("value: number");
      expect(type).toContain("next");
      expect(type.length).toBeLessThan(400);
    });

    it("handles a function with no parameters", () => {
      const file = sourceOf(`export function now(): number { return 1; }`);
      const [fn] = extractChangedFunctions(file, whole);
      expect(fn?.parameters).toEqual([]);
    });
  });
});
