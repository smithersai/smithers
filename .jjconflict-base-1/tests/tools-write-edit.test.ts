import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write, edit } from "../src/tools/index";
import { runWithToolContext } from "../src/tools/context";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb } from "./helpers";
import { ddl, schema } from "./schema";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-wt-"));
}

async function execTool<T>(tool: any, input: any): Promise<T> {
  return tool.execute(input, {} as any);
}

async function withToolContext<T>(
  rootDir: string,
  fn: () => Promise<T>,
  overrides?: Partial<{
    allowNetwork: boolean;
    maxOutputBytes: number;
    timeoutMs: number;
  }>,
) {
  const { db, cleanup } = createTestDb(schema, ddl);
  ensureSmithersTables(db as any);
  const adapter = new SmithersDb(db as any);
  try {
    return await runWithToolContext(
      {
        db: adapter,
        runId: "run",
        nodeId: "node",
        iteration: 0,
        attempt: 1,
        rootDir,
        allowNetwork: overrides?.allowNetwork ?? false,
        maxOutputBytes: overrides?.maxOutputBytes ?? 200_000,
        timeoutMs: overrides?.timeoutMs ?? 5000,
        seq: 0,
      },
      fn,
    );
  } finally {
    cleanup();
  }
}

describe("write tool", () => {
  test("writes file successfully", async () => {
    const root = makeTempDir();
    try {
      await withToolContext(root, () =>
        execTool(write, { path: "hello.txt", content: "hello world" }),
      );
      const content = readFileSync(join(root, "hello.txt"), "utf8");
      expect(content).toBe("hello world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates nested directories", async () => {
    const root = makeTempDir();
    try {
      await withToolContext(root, () =>
        execTool(write, { path: "a/b/c/deep.txt", content: "deep" }),
      );
      expect(existsSync(join(root, "a/b/c/deep.txt"))).toBe(true);
      expect(readFileSync(join(root, "a/b/c/deep.txt"), "utf8")).toBe("deep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects content exceeding max bytes", async () => {
    const root = makeTempDir();
    try {
      const bigContent = "x".repeat(200);
      await expect(
        withToolContext(
          root,
          () => execTool(write, { path: "big.txt", content: bigContent }),
          { maxOutputBytes: 64 },
        ),
      ).rejects.toThrow("Content too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(write, { path: "../escape.txt", content: "bad" }),
        ),
      ).rejects.toThrow("Path escapes sandbox root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edit tool", () => {
  test("applies unified diff patch successfully", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "file.txt"), "line1\nline2\nline3\n", "utf8");
      const patch = [
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-line2",
        "+line2_modified",
        " line3",
        "",
      ].join("\n");
      await withToolContext(root, () =>
        execTool(edit, { path: "file.txt", patch }),
      );
      const updated = readFileSync(join(root, "file.txt"), "utf8");
      expect(updated).toContain("line2_modified");
      expect(updated).not.toContain("\nline2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects patch when file is too large", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "big.txt"), "x".repeat(200), "utf8");
      const patch = "--- a/big.txt\n+++ b/big.txt\n@@ -1 +1 @@\n-x\n+y\n";
      await expect(
        withToolContext(
          root,
          () => execTool(edit, { path: "big.txt", patch }),
          { maxOutputBytes: 64 },
        ),
      ).rejects.toThrow("File too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects patch that is too large", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "file.txt"), "hello", "utf8");
      const bigPatch = "x".repeat(200);
      await expect(
        withToolContext(
          root,
          () => execTool(edit, { path: "file.txt", patch: bigPatch }),
          { maxOutputBytes: 64 },
        ),
      ).rejects.toThrow("Patch too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects patch that fails to apply", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "file.txt"), "actual content\n", "utf8");
      const patch = [
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1,1 +1,1 @@",
        "-nonexistent line",
        "+replacement",
        "",
      ].join("\n");
      await expect(
        withToolContext(root, () =>
          execTool(edit, { path: "file.txt", patch }),
        ),
      ).rejects.toThrow("Failed to apply patch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(edit, { path: "../escape.txt", patch: "anything" }),
        ),
      ).rejects.toThrow("Path escapes sandbox root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
