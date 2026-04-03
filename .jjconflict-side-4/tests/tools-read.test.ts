import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read } from "../src/tools/index";
import { runWithToolContext } from "../src/tools/context";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb } from "./helpers";
import { ddl, schema } from "./schema";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-read-test-"));
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

describe("read tool", () => {
  test("reads a file within sandbox", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "hello.txt"), "Hello, World!", "utf8");

      const result = await withToolContext(root, () =>
        execTool<string>(read, { path: "hello.txt" }),
      );

      expect(result).toBe("Hello, World!");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads nested file paths", async () => {
    const root = makeTempDir();
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "data.json"), '{"key":"value"}', "utf8");

      const result = await withToolContext(root, () =>
        execTool<string>(read, { path: "sub/data.json" }),
      );

      expect(result).toBe('{"key":"value"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects file that exceeds maxOutputBytes with TOOL_FILE_TOO_LARGE", async () => {
    const root = makeTempDir();
    try {
      // Create file larger than maxOutputBytes
      const bigContent = "A".repeat(500);
      writeFileSync(join(root, "big.txt"), bigContent, "utf8");

      await expect(
        withToolContext(
          root,
          () => execTool<string>(read, { path: "big.txt" }),
          { maxOutputBytes: 100 },
        ),
      ).rejects.toThrow("File too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects read of nonexistent file", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(read, { path: "does-not-exist.txt" }),
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal outside sandbox", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(read, { path: "../../etc/passwd" }),
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
