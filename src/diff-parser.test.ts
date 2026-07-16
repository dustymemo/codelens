import { describe, expect, it } from "vitest";

import { parseDiff } from "./diff-parser.js";

/** Builds a diff string from lines, so tests stay readable and newline-exact. */
const diff = (...lines: string[]): string => lines.join("\n") + "\n";

describe("parseDiff", () => {
  describe("file status", () => {
    it("marks a new file as added and ranges every added line", () => {
      const input = diff(
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "index 0000000..90334b4",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1,3 @@",
        "+export function fresh() {",
        "+  return 42;",
        "+}",
      );

      expect(parseDiff(input)).toEqual([
        { path: "added.ts", status: "added", changedRanges: [{ start: 1, end: 3 }] },
      ]);
    });

    it("marks a removed file as deleted with no ranges (nothing to execute)", () => {
      const input = diff(
        "diff --git a/todelete.ts b/todelete.ts",
        "deleted file mode 100644",
        "index de98044..0000000",
        "--- a/todelete.ts",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-a",
        "-b",
        "-c",
      );

      expect(parseDiff(input)).toEqual([
        { path: "todelete.ts", status: "deleted", changedRanges: [] },
      ]);
    });

    it("marks an edited file as modified", () => {
      const input = diff(
        "diff --git a/mod.ts b/mod.ts",
        "index 0ac2a0e..d31d8ce 100644",
        "--- a/mod.ts",
        "+++ b/mod.ts",
        "@@ -1,4 +1,5 @@",
        " export function calc(x) {",
        "   const base = x * 2;",
        "-  return base;",
        "+  const adj = base + 1;",
        "+  return adj;",
        " }",
      );

      expect(parseDiff(input)).toEqual([
        { path: "mod.ts", status: "modified", changedRanges: [{ start: 3, end: 4 }] },
      ]);
    });

    it("marks a pure rename as renamed, carrying previousPath and no ranges", () => {
      const input = diff(
        "diff --git a/rename-me.ts b/renamed.ts",
        "similarity index 100%",
        "rename from rename-me.ts",
        "rename to renamed.ts",
      );

      expect(parseDiff(input)).toEqual([
        {
          path: "renamed.ts",
          status: "renamed",
          previousPath: "rename-me.ts",
          changedRanges: [],
        },
      ]);
    });

    it("keeps renamed status but still ranges edits for a rename+edit", () => {
      const input = diff(
        "diff --git a/old.ts b/new.ts",
        "similarity index 80%",
        "rename from old.ts",
        "rename to new.ts",
        "index 0ac2a0e..d31d8ce 100644",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1,3 +1,3 @@",
        " export function calc() {",
        "-  return 1;",
        "+  return 2;",
        " }",
      );

      expect(parseDiff(input)).toEqual([
        {
          path: "new.ts",
          status: "renamed",
          previousPath: "old.ts",
          changedRanges: [{ start: 2, end: 2 }],
        },
      ]);
    });
  });

  describe("line ranges", () => {
    it("anchors a deletion-only hunk to the line that now occupies the gap", () => {
      // ` keep` is new line 1; `-dropme` is removed; ` keep2` is new line 2.
      // The removal must still surface, or a deletion-only change would be
      // invisible to the executor.
      const input = diff(
        "diff --git a/deleteonly.ts b/deleteonly.ts",
        "index 69b3f53..4031952 100644",
        "--- a/deleteonly.ts",
        "+++ b/deleteonly.ts",
        "@@ -1,3 +1,2 @@",
        " keep",
        "-dropme",
        " keep2",
      );

      expect(parseDiff(input)).toEqual([
        { path: "deleteonly.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });

    it("merges contiguous changed lines but keeps separated runs apart", () => {
      const input = diff(
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,4 +1,8 @@",
        "+one",
        "+two",
        " ctx",
        " ctx",
        " ctx",
        " ctx",
        "+seven",
        "+eight",
      );

      expect(parseDiff(input)).toEqual([
        {
          path: "a.ts",
          status: "modified",
          changedRanges: [
            { start: 1, end: 2 },
            { start: 7, end: 8 },
          ],
        },
      ]);
    });

    it("tracks line numbers across multiple hunks in one file", () => {
      const input = diff(
        "diff --git a/multi.ts b/multi.ts",
        "index 111..222 100644",
        "--- a/multi.ts",
        "+++ b/multi.ts",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+B",
        "@@ -50,2 +50,3 @@",
        " x",
        "+Y",
        " z",
      );

      expect(parseDiff(input)).toEqual([
        {
          path: "multi.ts",
          status: "modified",
          changedRanges: [
            { start: 2, end: 2 },
            { start: 51, end: 51 },
          ],
        },
      ]);
    });

    it("handles hunk headers that omit the count (implicit 1)", () => {
      const input = diff(
        "diff --git a/one.ts b/one.ts",
        "new file mode 100644",
        "index 0000000..943c458",
        "--- /dev/null",
        "+++ b/one.ts",
        "@@ -0,0 +1 @@",
        "+const x = 1;",
      );

      expect(parseDiff(input)).toEqual([
        { path: "one.ts", status: "added", changedRanges: [{ start: 1, end: 1 }] },
      ]);
    });

    it("ignores the section heading git appends to a hunk header", () => {
      const input = diff(
        "diff --git a/hint.ts b/hint.ts",
        "index 111..222 100644",
        "--- a/hint.ts",
        "+++ b/hint.ts",
        "@@ -10,2 +10,3 @@ export function calc(x: number) {",
        " const base = x;",
        "+const adj = base + 1;",
        " return base;",
      );

      expect(parseDiff(input)).toEqual([
        { path: "hint.ts", status: "modified", changedRanges: [{ start: 11, end: 11 }] },
      ]);
    });

    it("ignores the no-newline-at-EOF marker", () => {
      const input = diff(
        "diff --git a/eof.ts b/eof.ts",
        "index 111..222 100644",
        "--- a/eof.ts",
        "+++ b/eof.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      );

      expect(parseDiff(input)).toEqual([
        { path: "eof.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });

    it("treats a bare empty line inside a hunk as context", () => {
      // Some tools strip the trailing space from an empty context line.
      const input = diff(
        "diff --git a/blank.ts b/blank.ts",
        "index 111..222 100644",
        "--- a/blank.ts",
        "+++ b/blank.ts",
        "@@ -1,3 +1,4 @@",
        " a",
        "",
        " c",
        "+d",
      );

      expect(parseDiff(input)).toEqual([
        { path: "blank.ts", status: "modified", changedRanges: [{ start: 4, end: 4 }] },
      ]);
    });
  });

  describe("path handling", () => {
    it("strips the trailing tab git adds to a path containing a space", () => {
      const input = diff(
        "diff --git a/my file.ts b/my file.ts",
        "index 84275f9..e0c9b5e 100644",
        "--- a/my file.ts\t",
        "+++ b/my file.ts\t",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-line2",
        "+CHANGED",
        " line3",
      );

      expect(parseDiff(input)).toEqual([
        { path: "my file.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });

    it("decodes git's octal-escaped quoting for non-ASCII paths", () => {
      const input = diff(
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        "new file mode 100644",
        "index 0000000..943c458",
        "--- /dev/null",
        '+++ "b/caf\\303\\251.ts"',
        "@@ -0,0 +1 @@",
        "+const x = 1;",
      );

      expect(parseDiff(input)).toEqual([
        { path: "café.ts", status: "added", changedRanges: [{ start: 1, end: 1 }] },
      ]);
    });

    it("decodes escaped quotes and backslashes in a quoted path", () => {
      const input = diff(
        'diff --git "a/we\\"ird\\\\x.ts" "b/we\\"ird\\\\x.ts"',
        "index 111..222 100644",
        "--- \"a/we\\\"ird\\\\x.ts\"",
        '+++ "b/we\\"ird\\\\x.ts"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      );

      expect(parseDiff(input)).toEqual([
        { path: 'we"ird\\x.ts', status: "modified", changedRanges: [{ start: 1, end: 1 }] },
      ]);
    });

    it("keeps a directory literally named b/ intact", () => {
      // Only the a/ and b/ diff prefixes are stripped, not a real path segment.
      const input = diff(
        "diff --git a/b/nested.ts b/b/nested.ts",
        "index 111..222 100644",
        "--- a/b/nested.ts",
        "+++ b/b/nested.ts",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
      );

      expect(parseDiff(input)).toEqual([
        { path: "b/nested.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });
  });

  describe("whole-diff shape", () => {
    it("returns every file in a multi-file diff, in order", () => {
      const input = diff(
        "diff --git a/first.ts b/first.ts",
        "index 111..222 100644",
        "--- a/first.ts",
        "+++ b/first.ts",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
        "diff --git a/second.py b/second.py",
        "index 333..444 100644",
        "--- a/second.py",
        "+++ b/second.py",
        "@@ -5 +5,2 @@",
        " x",
        "+y",
      );

      expect(parseDiff(input)).toEqual([
        { path: "first.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
        { path: "second.py", status: "modified", changedRanges: [{ start: 6, end: 6 }] },
      ]);
    });

    it("reports a binary file with no ranges rather than dropping it", () => {
      const input = diff(
        "diff --git a/logo.png b/logo.png",
        "index 9956a96..4061d10 100644",
        "Binary files a/logo.png and b/logo.png differ",
      );

      expect(parseDiff(input)).toEqual([
        { path: "logo.png", status: "modified", changedRanges: [] },
      ]);
    });

    it("does not mistake hunk content for headers", () => {
      // A diff of a diff: body lines legitimately start with +++, ---, @@ and
      // `diff --git`. The hunk's declared counts are what bound the body.
      const input = diff(
        "diff --git a/meta.txt b/meta.txt",
        "index 111..222 100644",
        "--- a/meta.txt",
        "+++ b/meta.txt",
        "@@ -1,4 +1,5 @@",
        " diff --git a/inner.ts b/inner.ts",
        " --- a/inner.ts",
        "+++ b/inner.ts",
        " @@ -1 +1 @@",
        " tail",
        "diff --git a/after.ts b/after.ts",
        "index 333..444 100644",
        "--- a/after.ts",
        "+++ b/after.ts",
        "@@ -1 +1,2 @@",
        " z",
        "+w",
      );

      expect(parseDiff(input)).toEqual([
        { path: "meta.txt", status: "modified", changedRanges: [{ start: 3, end: 3 }] },
        { path: "after.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });

    it("tolerates CRLF line endings", () => {
      const input = [
        "diff --git a/crlf.ts b/crlf.ts",
        "index 111..222 100644",
        "--- a/crlf.ts",
        "+++ b/crlf.ts",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
      ].join("\r\n");

      expect(parseDiff(input)).toEqual([
        { path: "crlf.ts", status: "modified", changedRanges: [{ start: 2, end: 2 }] },
      ]);
    });

    it.each([["" as const], ["   \n\n"], ["not a diff at all\njust prose\n"]])(
      "returns an empty array for non-diff input %j",
      (input) => {
        expect(parseDiff(input)).toEqual([]);
      },
    );
  });
});
