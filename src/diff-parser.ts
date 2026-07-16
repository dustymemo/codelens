/** How a file was touched by the diff. */
export type FileStatus = "added" | "modified" | "deleted" | "renamed";

/** An inclusive run of line numbers in the file's post-image (1-based). */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** One file's worth of change, ready for language routing and function lookup. */
export interface ChangedFile {
  /** Post-image path, diff prefix (`a/`, `b/`) already stripped. */
  readonly path: string;
  readonly status: FileStatus;
  /** Pre-rename path. Only present when `status` is `"renamed"`. */
  readonly previousPath?: string;
  /**
   * Touched line ranges in the post-image, ascending and non-overlapping.
   * Always empty for `"deleted"` — there is no post-image to execute.
   */
  readonly changedRanges: readonly LineRange[];
}

const GIT_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a git unified diff into the changed files and the line ranges touched in
 * each one.
 *
 * This deliberately stops at line ranges rather than function bodies: a unified
 * diff carries only a few lines of context per hunk, so a modified function's
 * body is usually truncated and cannot be recovered from the diff alone. The
 * checkout on the runner has the real files, so the type-extractor resolves each
 * range to its enclosing function from source. That also keeps this parser
 * language-agnostic — brace/indent rules live in one place, not two.
 *
 * Deletions have no post-image lines of their own, so a removed line anchors to
 * the line that now occupies its position. Without that, a deletion-only change
 * would parse to zero ranges and silently vanish from the report.
 *
 * @param unifiedDiff Output of `git diff` (expects `diff --git` file headers).
 * @returns One entry per file, in diff order. Empty for input containing no
 *   file headers.
 */
export function parseDiff(unifiedDiff: string): readonly ChangedFile[] {
  const lines = unifiedDiff.split("\n").map(stripCarriageReturn);
  const files: ChangedFile[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    if (!(lines[cursor] ?? "").startsWith(GIT_HEADER)) {
      cursor += 1;
      continue;
    }
    const section = parseFileSection(lines, cursor);
    if (section.file !== null) files.push(section.file);
    cursor = section.next;
  }
  return files;
}

interface Section {
  readonly file: ChangedFile | null;
  readonly next: number;
}

/** Parse one `diff --git` block: its headers, then any hunks. */
function parseFileSection(lines: readonly string[], start: number): Section {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isNewFile = false;
  let isDeletedFile = false;
  // `--- /dev/null` means the file was created; `+++ /dev/null` means removed.
  let oldIsDevNull = false;
  let newIsDevNull = false;
  const touched = new Set<number>();

  let cursor = start + 1;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (line.startsWith(GIT_HEADER)) break;

    if (line.startsWith("@@")) {
      cursor = parseHunk(lines, cursor, touched);
      continue;
    }

    if (line.startsWith("new file mode ")) {
      isNewFile = true;
    } else if (line.startsWith("deleted file mode ")) {
      isDeletedFile = true;
    } else if (line.startsWith("rename from ")) {
      renameFrom = decodePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      renameTo = decodePath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      const parsed = decodePath(line.slice(4));
      if (parsed === "/dev/null") oldIsDevNull = true;
      else oldPath = stripDiffPrefix(parsed);
    } else if (line.startsWith("+++ ")) {
      const parsed = decodePath(line.slice(4));
      if (parsed === "/dev/null") newIsDevNull = true;
      else newPath = stripDiffPrefix(parsed);
    }
    cursor += 1;
  }

  // Binary and mode-only entries carry no `+++` line; fall back to the header.
  const path = renameTo ?? newPath ?? oldPath ?? parseHeaderPath(lines[start] ?? "");
  if (path === null) return { file: null, next: cursor };

  const status = resolveStatus({
    renamed: renameTo !== null,
    deleted: isDeletedFile || newIsDevNull,
    added: isNewFile || oldIsDevNull,
  });
  const changedRanges = status === "deleted" ? [] : toRanges(touched);
  const file: ChangedFile =
    status === "renamed" && renameFrom !== null
      ? { path, status, previousPath: renameFrom, changedRanges }
      : { path, status, changedRanges };

  return { file, next: cursor };
}

function resolveStatus(signals: {
  renamed: boolean;
  deleted: boolean;
  added: boolean;
}): FileStatus {
  if (signals.renamed) return "renamed";
  if (signals.deleted) return "deleted";
  if (signals.added) return "added";
  return "modified";
}

/**
 * Consume one hunk, recording touched post-image lines into `touched`.
 *
 * The hunk header's declared counts bound the body — not a scan for the next
 * `@@`/`+++`. A diff of a diff has body lines that legitimately start with those
 * markers, and only the counts say where the hunk really ends.
 *
 * @returns Index of the first line after the hunk.
 */
function parseHunk(lines: readonly string[], start: number, touched: Set<number>): number {
  const header = HUNK_HEADER.exec(lines[start] ?? "");
  if (header === null) return start + 1;

  // An omitted count means 1 (`@@ -0,0 +1 @@`).
  let oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
  let newRemaining = header[4] === undefined ? 1 : Number(header[4]);
  let newLine = Number(header[3]);

  let cursor = start + 1;
  while (cursor < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const line = lines[cursor] ?? "";
    // Guard against a malformed header over-consuming the next file.
    if (line.startsWith(GIT_HEADER)) break;

    if (line.startsWith("\\")) {
      // `\ No newline at end of file` annotates the previous line; it is not content.
      cursor += 1;
      continue;
    }

    // A context line may arrive as "" when a tool strips its trailing space.
    const marker = line[0] ?? " ";
    if (marker === "+") {
      touched.add(newLine);
      newLine += 1;
      newRemaining -= 1;
    } else if (marker === "-") {
      touched.add(newLine);
      oldRemaining -= 1;
    } else {
      newLine += 1;
      newRemaining -= 1;
      oldRemaining -= 1;
    }
    cursor += 1;
  }
  return cursor;
}

/** Collapse touched line numbers into ascending, non-overlapping ranges. */
function toRanges(touched: ReadonlySet<number>): readonly LineRange[] {
  const sorted = [...touched].filter((n) => n > 0).sort((a, b) => a - b);
  const ranges: LineRange[] = [];

  let start: number | null = null;
  let previous = 0;
  for (const line of sorted) {
    if (start === null) {
      start = line;
    } else if (line > previous + 1) {
      ranges.push({ start, end: previous });
      start = line;
    }
    previous = line;
  }
  if (start !== null) ranges.push({ start, end: previous });
  return ranges;
}

/**
 * Best-effort post-image path from a `diff --git a/x b/x` line, for entries with
 * no `+++` line (binary, mode-only). Renames never rely on this — they carry an
 * explicit `rename to`.
 */
function parseHeaderPath(headerLine: string): string | null {
  const rest = headerLine.slice(GIT_HEADER.length).trim();

  // When quoted, the post-image path is the trailing quoted token.
  const quoted = /"((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted !== undefined && quoted !== null) {
    return stripDiffPrefix(unquotePath(`"${quoted[1] ?? ""}"`));
  }

  // Unquoted `a/P b/P` is ambiguous when P contains spaces, but git only omits
  // quotes when both paths are equal here, so the midpoint is exact:
  // length = "a/" + P + " " + "b/" + P  →  |P| = (length - 5) / 2.
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0) {
    const left = rest.slice(0, 2 + half);
    const right = rest.slice(3 + half);
    if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) {
      return right.slice(2);
    }
  }
  return null;
}

/**
 * Decode one path as it appears in a diff header: git C-quotes paths with
 * non-ASCII or control characters, and appends a tab terminator to unquoted
 * paths containing a space.
 */
function decodePath(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('"')) return unquotePath(trimmed);
  // The tab terminator (and any `diff -u` timestamp after it) is not the name.
  const tab = trimmed.indexOf("\t");
  return tab === -1 ? trimmed : trimmed.slice(0, tab);
}

const ESCAPE_BYTES: Readonly<Record<string, number>> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/**
 * Reverse git's C-style path quoting, e.g. `"a/caf\303\251.ts"` → `a/café.ts`.
 * Octal escapes are raw UTF-8 bytes, so decoding happens over bytes rather than
 * characters — per-escape decoding would corrupt any multi-byte character.
 */
function unquotePath(quoted: string): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];

  let cursor = 1; // Skip the opening quote.
  while (cursor < quoted.length) {
    const char = quoted[cursor];
    if (char === undefined || char === '"') break;

    if (char !== "\\") {
      for (const byte of encoder.encode(char)) bytes.push(byte);
      cursor += 1;
      continue;
    }

    const escaped = quoted[cursor + 1];
    if (escaped === undefined) break;

    const known = ESCAPE_BYTES[escaped];
    if (known !== undefined) {
      bytes.push(known);
      cursor += 2;
      continue;
    }

    const octal = /^[0-7]{1,3}/.exec(quoted.slice(cursor + 1, cursor + 4));
    if (octal !== null) {
      const digits = octal[0];
      bytes.push(parseInt(digits, 8) & 0xff);
      cursor += 1 + digits.length;
      continue;
    }

    // Unrecognized escape — keep the character as written.
    for (const byte of encoder.encode(escaped)) bytes.push(byte);
    cursor += 2;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Strip the `a/` or `b/` diff prefix, leaving a real leading `b/` directory alone. */
function stripDiffPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
