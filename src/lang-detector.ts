/** Languages CodeLens can route a changed file to. */
export type Language = "typescript" | "python" | "react" | "html";

/** A detected language plus whether Phase 1 can actually execute it. */
export interface DetectedLanguage {
  readonly language: Language;
  /** Executable now (TypeScript/Python). React/HTML are Phase 2 — detected but not run. */
  readonly supported: boolean;
}

// Extension → language. Keys are lowercase, without the leading dot.
const EXTENSION_TO_LANGUAGE: Readonly<Record<string, Language>> = {
  ts: "typescript",
  js: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  tsx: "react",
  jsx: "react",
  html: "html",
  htm: "html",
};

// Single source of truth for what Phase 1 can execute. Everything else is
// detected but marked unsupported — no per-extension booleans to drift out of sync.
const EXECUTABLE_LANGUAGES: ReadonlySet<Language> = new Set(["typescript", "python"]);

/**
 * Detect the language of a changed file from its extension, so the orchestrator can
 * route it to the matching executor.
 *
 * - `.ts` / `.js` / `.mjs` / `.cjs` (no JSX) → `typescript` (Phase 1, executable)
 * - `.py` → `python` (Phase 1, executable)
 * - `.tsx` / `.jsx` → `react` (Phase 2, detected but not yet executable)
 * - `.html` / `.htm` → `html` (Phase 2, detected but not yet executable)
 *
 * Extension matching is case-insensitive and uses only the file's basename, so
 * directory names containing dots don't interfere.
 *
 * @param filePath A file path or bare filename.
 * @returns The detected language and whether Phase 1 can execute it, or `null` if the
 *   extension is unrecognized (or the file has no extension / is a dotfile).
 */
export function detectLanguage(filePath: string): DetectedLanguage | null {
  const ext = extractExtension(filePath);
  if (ext === null) return null;
  const language = EXTENSION_TO_LANGUAGE[ext];
  if (language === undefined) return null;
  // Fresh object each call — never hands back a reference to shared module state.
  return { language, supported: EXECUTABLE_LANGUAGES.has(language) };
}

/** Lowercased extension (no dot) of a path's basename, or `null` when there isn't one. */
function extractExtension(filePath: string): string | null {
  const basename = filePath.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  // `dot <= 0` covers both "no dot" and leading-dot dotfiles like ".gitignore".
  if (dot <= 0) return null;
  const ext = basename.slice(dot + 1).toLowerCase();
  return ext.length > 0 ? ext : null;
}
