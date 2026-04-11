import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithToolContext, type ToolContext } from "../src/context";
import { Effect } from "effect";
import { grepToolEffect } from "../src/grep";

const TMP = join(tmpdir(), `smithers-grep-test-${Date.now()}`);

function makeToolContext(rootDir: string): ToolContext {
  return {
    db: {} as any,
    runId: "test-run",
    nodeId: "test-node",
    iteration: 0,
    attempt: 0,
    rootDir,
    allowNetwork: false,
    maxOutputBytes: 200_000,
    timeoutMs: 10_000,
    seq: 0,
  };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "hello.txt"), "Hello World\nGoodbye World\nHello Again\n");
  writeFileSync(join(TMP, "data.json"), '{"key": "value"}\n');
  mkdirSync(join(TMP, "sub"), { recursive: true });
  writeFileSync(join(TMP, "sub", "nested.txt"), "Nested Hello\n");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("grepToolEffect", () => {
  test("finds matching lines in files", async () => {
    const ctx = makeToolContext(TMP);
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(grepToolEffect("Hello", ".")),
    );
    expect(result).toContain("Hello World");
    expect(result).toContain("Hello Again");
  });

  test("searches nested directories", async () => {
    const ctx = makeToolContext(TMP);
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(grepToolEffect("Nested", ".")),
    );
    expect(result).toContain("Nested Hello");
  });

  test("returns empty output for no matches", async () => {
    const ctx = makeToolContext(TMP);
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(grepToolEffect("NONEXISTENT_PATTERN_XYZ", ".")),
    );
    expect(result).toBe("");
  });

  test("searches specific file via path", async () => {
    const ctx = makeToolContext(TMP);
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(grepToolEffect("key", "data.json")),
    );
    expect(result).toContain("key");
  });

  test("uses regex patterns", async () => {
    const ctx = makeToolContext(TMP);
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(grepToolEffect("Hello.*World", ".")),
    );
    expect(result).toContain("Hello World");
    // "Hello Again" should NOT match the pattern "Hello.*World"
    expect(result).not.toContain("Hello Again");
  });
});
