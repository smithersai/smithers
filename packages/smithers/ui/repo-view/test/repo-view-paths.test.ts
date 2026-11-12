// The repo view's pure helpers over a flat file list: what a directory holds, the tree's order, where a README's
// links lead, and the labels a file's toolbar shows.
import { describe, expect, spyOn, test } from "bun:test";
import {
  ancestorsOf,
  compareNames,
  directoriesOf,
  directoryEntries,
  formatBytes,
  isMarkdown,
  lineCount,
  parentOf,
  resolveLink,
  treeOrder,
} from "../src/paths";

const PATHS = ["src/router.ts", "README.md", ".github/ci.yml", "src/middleware/json.ts", "LICENSE", "docs/a b.md"];

describe("repo view paths", () => {
  test("names sort case-insensitively, the raw name breaking ties", () => {
    expect(["b", "README.md", "a", "B", "license"].sort(compareNames)).toEqual(["a", "b", "B", "license", "README.md"]);
  });

  test("parents and ancestors", () => {
    expect(parentOf("src/middleware/json.ts")).toBe("src/middleware");
    expect(parentOf("README.md")).toBe("");
    expect(ancestorsOf("src/middleware/json.ts")).toEqual(["src", "src/middleware"]);
    expect(ancestorsOf("README.md")).toEqual([]);
    expect([...directoriesOf(PATHS)].sort()).toEqual([".github", "docs", "src", "src/middleware"]);
  });

  test("a directory's entries: directories first, then files, each by name", () => {
    expect(directoryEntries(PATHS, "")).toEqual([
      { name: ".github", path: ".github", kind: "directory" },
      { name: "docs", path: "docs", kind: "directory" },
      { name: "src", path: "src", kind: "directory" },
      { name: "LICENSE", path: "LICENSE", kind: "file" },
      { name: "README.md", path: "README.md", kind: "file" },
    ]);
    expect(directoryEntries(PATHS, "src")).toEqual([
      { name: "middleware", path: "src/middleware", kind: "directory" },
      { name: "router.ts", path: "src/router.ts", kind: "file" },
    ]);
    // A prefix that is not a whole segment holds nothing, and neither does a file.
    expect(directoryEntries(PATHS, "sr")).toEqual([]);
    expect(directoryEntries(["src/"], "src")).toEqual([]);
  });

  test("the tree's order puts directories before files at every level", () => {
    expect(treeOrder(PATHS)).toEqual([
      ".github/ci.yml",
      "docs/a b.md",
      "src/middleware/json.ts",
      "src/router.ts",
      "LICENSE",
      "README.md",
    ]);
    expect(treeOrder(["a.ts", "a.ts"])).toEqual(["a.ts", "a.ts"]);
  });

  test("the tree's order matches comparing whole paths, and splits each path once", () => {
    // The order as a whole-path comparator gives it: directories first at the first segment that differs.
    const byWholePath = (a: string, b: string): number => {
      const left = a.split("/");
      const right = b.split("/");
      for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const leftIsDirectory = index < left.length - 1;
        const rightIsDirectory = index < right.length - 1;
        if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
        const order = compareNames(left[index]!, right[index]!);
        if (order !== 0) return order;
      }
      return 0;
    };
    const names = ["a", "B", "b", "README.md", "_x", "Z.ts", "10.ts", "9.ts", "é.md"];
    const sample = names.flatMap((first) => names.flatMap((second) => [first, `${first}/${second}`, `${second}/${first}/${second}`]));
    const unique = [...new Set(sample)].filter((path) => !sample.some((other) => other.startsWith(`${path}/`)));
    expect(treeOrder(unique)).toEqual([...unique].sort(byWholePath));

    // A repository of 100,000 files: a whole-path comparator splits two paths per comparison, millions of times.
    const large = Array.from({ length: 100_000 }, (_, n) => `packages/pkg${n % 50}/src/dir${n % 7}/sub${n % 3}/file${n}.ts`);
    const split = spyOn(String.prototype, "split");
    try {
      const ordered = treeOrder(large);
      expect(split.mock.calls.length).toBeLessThanOrEqual(large.length);
      expect(ordered.length).toBe(large.length);
    } finally {
      split.mockRestore();
    }
  });

  test("Markdown, line counts and sizes", () => {
    expect(["a.md", "B.MDX", "c.markdown", "d.txt", "md"].map(isMarkdown)).toEqual([true, true, true, false, false]);
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(formatBytes(587)).toBe("587 B");
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });

  test("a README's links resolve as GitHub resolves them", () => {
    const from = "docs/guide.md";
    expect(resolveLink(from, "a%20b.md", PATHS)).toEqual({ kind: "blob", path: "docs/a b.md" });
    expect(resolveLink(from, "./a b.md#usage", PATHS)).toEqual({ kind: "blob", path: "docs/a b.md" });
    expect(resolveLink(from, "../src/", PATHS)).toEqual({ kind: "tree", path: "src" });
    expect(resolveLink(from, "/src/router.ts?plain=1", PATHS)).toEqual({ kind: "blob", path: "src/router.ts" });
    expect(resolveLink(from, "..", PATHS)).toEqual({ kind: "tree", path: "" });
    expect(resolveLink(from, "missing.md", PATHS)).toEqual({ kind: "blob", path: "docs/missing.md" });
    // A folder known only by name, and any path written as a folder, opens the tree.
    expect(resolveLink("README.md", "docs", [], ["docs/api"])).toEqual({ kind: "tree", path: "docs" });
    expect(resolveLink("README.md", "./docs/api", [], ["docs/api"])).toEqual({ kind: "tree", path: "docs/api" });
    expect(resolveLink(from, "missing/", PATHS)).toEqual({ kind: "tree", path: "docs/missing" });
    // The browser keeps external links, anchors, a link above the root and one it can't decode.
    for (const href of ["https://example.com", "mailto:a@b.c", "//cdn.example.com/x", "#usage", "?q", "../../x", "%E0%A4%A"]) {
      expect(resolveLink(from, href, PATHS)).toBeUndefined();
    }
  });
});
