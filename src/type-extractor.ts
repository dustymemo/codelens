import {
  Node,
  Scope,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol as TsSymbol,
  type Type,
} from "ts-morph";

import type { LineRange } from "./diff-parser.js";

/** How a function was written. Affects how the executor has to reach it. */
export type FunctionKind = "function" | "arrow" | "method";

/** One parameter, described well enough for the input-generator to invent values. */
export interface ParameterInfo {
  readonly name: string;
  /** Structural type text, e.g. `{ id: number; name: string }` — never a module path. */
  readonly type: string;
  /** Declared with `?`. */
  readonly optional: boolean;
  /** Has an initializer, so callers may omit it. */
  readonly hasDefault: boolean;
}

/** A changed function, resolved from source rather than from the diff. */
export interface ExtractedFunction {
  /** Qualified for methods (`Calculator.add`), bare otherwise. */
  readonly name: string;
  readonly kind: FunctionKind;
  readonly isExported: boolean;
  readonly isAsync: boolean;
  readonly parameters: readonly ParameterInfo[];
  readonly returnType: string;
  /** Full source text of the function, including any nested helpers. */
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The function-like nodes CodeLens can execute. */
type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;

/**
 * Depth cap for structural expansion. Three levels is enough for the
 * input-generator to invent a value; beyond that the type name is more useful
 * to a reader than another page of nesting.
 */
const MAX_DEPTH = 3;

/**
 * Resolve the functions touched by a diff's changed line ranges, with their
 * parameter and return types expanded structurally.
 *
 * This is the other half of the CL-4 split: the diff gives line ranges, and the
 * real file (checked out on the runner) gives the function. Types come from the
 * checker and are expanded to their shape — an imported `User` becomes
 * `{ id: number; name: string }`, because the input-generator cannot invent a
 * value from a bare name.
 *
 * Only top-level units are reported. A nested closure is not independently
 * callable, so when a change lands inside one, the enclosing top-level function
 * is what the executor can actually run.
 *
 * @param sourceFile Parsed file, from a project wide enough to resolve its imports.
 *   The project should be configured with `strictNullChecks` (normally via the
 *   repo's own tsconfig): without it the checker folds `null` and `undefined`
 *   into their neighbours, so `string | null` arrives here as plain `string` and
 *   the input-generator is never told that null is reachable.
 * @param changedRanges Post-image line ranges from the diff-parser.
 * @returns One entry per touched function, in source order.
 */
export function extractChangedFunctions(
  sourceFile: SourceFile,
  changedRanges: readonly LineRange[],
): readonly ExtractedFunction[] {
  if (changedRanges.length === 0) return [];

  return collectCallableUnits(sourceFile)
    .filter((unit) => intersectsAny(unit.startLine, unit.endLine, changedRanges))
    .map(({ node, ...identity }) => ({
      ...identity,
      isAsync: node.isAsync(),
      parameters: node.getParameters().map(describeParameter),
      returnType: describeType(node.getReturnType(), node, new Set(), 0),
      text: node.getText(),
    }));
}

/** A function-like the executor can actually call, with its identity resolved. */
interface CallableUnit {
  readonly node: FunctionLike;
  readonly name: string;
  readonly kind: FunctionKind;
  readonly isExported: boolean;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Collect the callable units of a file: top-level functions, top-level
 * `const f = () => {}`, and class methods. Nested closures are deliberately
 * excluded — see the note on `extractChangedFunctions`.
 */
function collectCallableUnits(sourceFile: SourceFile): CallableUnit[] {
  const units: CallableUnit[] = [];

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    // A default-exported anonymous function has no name to call it by.
    if (name === undefined) continue;
    units.push({
      node: fn,
      name,
      kind: "function",
      isExported: fn.isExported(),
      ...lineSpan(fn),
    });
  }

  // getVariableDeclarations() is top-level only, so nested closures stay excluded.
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (initializer === undefined) continue;
    if (!Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) continue;
    units.push({
      node: initializer,
      name: declaration.getName(),
      kind: "arrow",
      isExported: declaration.isExported(),
      ...lineSpan(declaration),
    });
  }

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() ?? "(anonymous)";
    const classExported = cls.isExported();
    for (const method of cls.getMethods()) {
      units.push({
        node: method,
        name: `${className}.${method.getName()}`,
        kind: "method",
        // A method is only reachable if its class is.
        isExported: classExported && method.getScope() === Scope.Public,
        ...lineSpan(method),
      });
    }
  }

  return units.sort((a, b) => a.startLine - b.startLine);
}

function lineSpan(node: Node): { startLine: number; endLine: number } {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}

function intersectsAny(start: number, end: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) => range.start <= end && range.end >= start);
}

function describeParameter(parameter: ParameterDeclaration): ParameterInfo {
  const optional = parameter.hasQuestionToken();
  return {
    name: parameter.getName(),
    // `optional` already says undefined is allowed; repeating it in the type
    // would just be noise in the prompt.
    type: describeType(parameter.getType(), parameter, new Set(), 0, optional),
    optional,
    hasDefault: parameter.hasInitializer(),
  };
}

/**
 * Render a type as structural text the input-generator can act on.
 *
 * Expansion is decided by shape, not by declaration site, with one narrow
 * exception for packages (see `isFromExternalPackage`). It stops at `MAX_DEPTH`
 * and at any type already being expanded — a self-referential type like
 * `interface Node { next: Node }` would otherwise recurse forever.
 */
function describeType(
  type: Type,
  atNode: Node,
  seen: ReadonlySet<Type>,
  depth: number,
  dropUndefined = false,
): string {
  const name = () => renderTypeName(type, atNode);

  if (type.isUnion()) {
    // `boolean` is modelled as `true | false`; normalising collapses it back,
    // so plain unions and boolean take the same path.
    const members = normalizeUnionMembers(type.getUnionTypes(), dropUndefined);
    const only = members.length === 1 ? members[0] : undefined;
    if (only !== undefined && only !== BOOLEAN) {
      return describeType(only, atNode, seen, depth);
    }
    return members
      .map((member) => (member === BOOLEAN ? "boolean" : describeType(member, atNode, seen, depth)))
      .join(" | ");
  }

  if (type.isArray()) {
    const element = type.getArrayElementType();
    if (element === undefined) return name();
    const inner = describeType(element, atNode, seen, depth);
    // Parenthesise unions so `(a | b)[]` does not read as `a | b[]`.
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }

  // Primitives, literals, enums and `any` are already at their most readable.
  if (!type.isObject() || type.isEnum()) return name();
  if (depth >= MAX_DEPTH || seen.has(type)) return name();
  if (!isExpandableShape(type, atNode)) return name();

  const properties = type.getProperties().filter(isPublicProperty);
  const nested = new Set(seen).add(type);
  const rendered = properties.map((property) => {
    const declaration = property.getValueDeclaration() ?? atNode;
    const propertyType = property.getTypeAtLocation(declaration);
    const isOptional = property.isOptional();
    // The checker gives `email?: undefined | string`; the `?` already says that.
    const text = describeType(propertyType, declaration, nested, depth + 1, isOptional);
    return `${property.getName()}${isOptional ? "?" : ""}: ${text}`;
  });
  return `{ ${rendered.join("; ")} }`;
}

/**
 * Sentinel for a `true | false` pair recombined into `boolean`.
 *
 * TypeScript models `boolean` as a union of its two literals, so dropping
 * `undefined` from `boolean | undefined` would otherwise leave `false | true` —
 * a needlessly confusing way to write `boolean`.
 */
const BOOLEAN = Symbol("boolean");

/** Drop `undefined` when the `?` already conveys it, and recombine `true | false`. */
function normalizeUnionMembers(
  members: readonly Type[],
  dropUndefined: boolean,
): readonly (Type | typeof BOOLEAN)[] {
  const kept = dropUndefined ? members.filter((member) => !member.isUndefined()) : members;
  const booleanLiterals = kept.filter((member) => member.isBooleanLiteral());
  if (booleanLiterals.length !== 2) return kept;

  const collapsed: (Type | typeof BOOLEAN)[] = [];
  let booleanAdded = false;
  for (const member of kept) {
    if (!member.isBooleanLiteral()) {
      collapsed.push(member);
      continue;
    }
    if (booleanAdded) continue;
    collapsed.push(BOOLEAN);
    booleanAdded = true;
  }
  return collapsed;
}

/**
 * Whether expanding this type tells the input-generator anything useful.
 *
 * The question is the type's shape, not where it was declared. Asking about the
 * declaration site gets it wrong both ways: a repo's own `types.d.ts` interface
 * is plain data that must expand, while a repo-local class is a method wall that
 * must not.
 */
function isExpandableShape(type: Type, atNode: Node): boolean {
  // A callable describes behaviour; there is no shape to build a value from.
  if (type.getCallSignatures().length > 0) return false;
  if (type.getConstructSignatures().length > 0) return false;
  if (isFromExternalPackage(type)) return false;

  const properties = type.getProperties().filter(isPublicProperty);
  if (properties.length === 0) return false;
  // A method wall (a class, `Date`): expanding dumps signatures, not shape.
  return !properties.every((property) => isCallableProperty(property, atNode));
}

/**
 * True for types owned by an installed package, including TypeScript's own
 * `lib.*.d.ts` (which resolve under `node_modules/typescript/lib`).
 *
 * Shape alone is not enough here: `Error` is all data (`name`, `message`,
 * `stack`) and would expand, and `Map` mixes a `size` field among its methods.
 * Neither is a type the author defined, so the name is what a reader wants.
 * This deliberately does not ask `isDeclarationFile()` — that would also catch
 * a repo's own hand-written ambient types, which are exactly what must expand.
 */
function isFromExternalPackage(type: Type): boolean {
  const declarations = type.getSymbol()?.getDeclarations() ?? [];
  return declarations.some((declaration) => declaration.getSourceFile().isInNodeModules());
}

/** Non-public members are unreachable to a caller, so they are not part of the shape. */
function isPublicProperty(property: TsSymbol): boolean {
  const declaration = property.getValueDeclaration() ?? property.getDeclarations()[0];
  if (declaration === undefined) return true; // Synthesized (mapped/intersection types).
  return Node.isScoped(declaration) ? declaration.getScope() === Scope.Public : true;
}

function isCallableProperty(property: TsSymbol, atNode: Node): boolean {
  const declaration = property.getValueDeclaration() ?? atNode;
  return property.getTypeAtLocation(declaration).getCallSignatures().length > 0;
}

/**
 * Render a type by name, with no module path in it.
 *
 * The checker writes a cross-file type as `import("/abs/path").User` whenever the
 * symbol is out of scope at the node being rendered. Passing an enclosing node
 * avoids that in the common case, but not for synthesized properties that have
 * no declaration of their own to render against. A runner's absolute path must
 * never reach a public PR comment, so the guard stays.
 */
function renderTypeName(type: Type, atNode: Node): string {
  const text = type.getText(atNode);
  if (!text.includes("import(")) return text;
  return text
    .replace(/import\((?:"[^"]*"|'[^']*')\)\./g, "")
    // Anything still carrying a path (e.g. `typeof import("./mod.js")`) has no
    // name to fall back on; say so rather than leak the path.
    .replace(/import\((?:"[^"]*"|'[^']*')\)/g, "<module>");
}
