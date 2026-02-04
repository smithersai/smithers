import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read, grep, bash } from "../src/tools/index";
import { runWithToolContext } from "../src/tools/context";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb } from "./helpers";
import { ddl, schema } from "./schema";

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
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
        maxOutputBytes: overrides?.maxOutputBytes ?? 128,
        timeoutMs: overrides?.timeoutMs ?? 50,
        seq: 0,
      },
      fn,
    );
  } finally {
    cleanup();
  }
}

describe("tools sandbox", () => {
  test("read rejects path traversal", async () => {
    const root = makeTempDir("smithers-root-");
    try {
      await expect(withToolContext(root, () => execTool(read, { path: "../outside.txt" }))).rejects.toThrow(
        "Path escapes sandbox root",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("read rejects symlink escape", async () => {
    const root = makeTempDir("smithers-root-");
    const outside = makeTempDir("smithers-outside-");
    try {
      const secret = join(outside, "secret.txt");
      writeFileSync(secret, "top-secret", "utf8");
      symlinkSync(outside, join(root, "link"));
      await expect(withToolContext(root, () => execTool(read, { path: "link/secret.txt" }))).rejects.toThrow(
        "Path escapes sandbox root",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("read enforces size cap", async () => {
    const root = makeTempDir("smithers-root-");
    try {
      const big = join(root, "big.txt");
      writeFileSync(big, "x".repeat(256), "utf8");
      await expect(
        withToolContext(root, () => execTool(read, { path: "big.txt" }), { maxOutputBytes: 64 }),
      ).rejects.toThrow("File too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tools behavior", () => {
  test("grep surfaces regex errors", async () => {
    if (!Bun.which("rg")) {
      return;
    }
    const root = makeTempDir("smithers-root-");
    try {
      writeFileSync(join(root, "file.txt"), "hello", "utf8");
      await expect(withToolContext(root, () => execTool(grep, { pattern: "[", path: "." }))).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bash times out", async () => {
    const root = makeTempDir("smithers-root-");
    try {
      await expect(
        withToolContext(root, () => execTool(bash, { cmd: "sleep", args: ["1"] }), { timeoutMs: 10 }),
      ).rejects.toThrow("timed out");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
