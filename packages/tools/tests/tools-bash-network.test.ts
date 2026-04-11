import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithToolContext, type ToolContext } from "../src/context";
import { Effect } from "effect";
import { bashToolEffect } from "../src/bash";

const TMP = join(tmpdir(), `smithers-bash-test-${Date.now()}`);

function makeToolContext(
  rootDir: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
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
    ...overrides,
  };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "test.txt"), "hello\n");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("bashToolEffect", () => {
  test("executes simple command with network allowed", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: true });
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(bashToolEffect("echo", ["hello"])),
    );
    expect(result).toContain("hello");
  });

  test("reads file with network allowed", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: true });
    const result = await runWithToolContext(ctx, () =>
      Effect.runPromise(bashToolEffect("cat", ["test.txt"])),
    );
    expect(result).toContain("hello");
  });

  test("blocks curl when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("curl https://example.com")),
      ),
    ).rejects.toThrow();
  });

  test("blocks wget when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("wget https://example.com")),
      ),
    ).rejects.toThrow();
  });

  test("blocks git push when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("git push origin main")),
      ),
    ).rejects.toThrow();
  });

  test("blocks git fetch when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("git fetch")),
      ),
    ).rejects.toThrow();
  });

  test("blocks git clone when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("git clone https://github.com/foo/bar")),
      ),
    ).rejects.toThrow();
  });

  test("allows git status (network validation does not block it)", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    // git status doesn't hit the network validation (no push/pull/fetch/clone/remote).
    // It may still fail (sandbox-exec or non-git dir), but not with TOOL_NETWORK_DISABLED
    // or TOOL_GIT_REMOTE_DISABLED.
    try {
      await runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("git", ["status"])),
      );
    } catch (err: any) {
      expect(err.code).not.toBe("TOOL_NETWORK_DISABLED");
      expect(err.code).not.toBe("TOOL_GIT_REMOTE_DISABLED");
    }
  });

  test("blocks npm install when network disabled", async () => {
    const ctx = makeToolContext(TMP, { allowNetwork: false });
    await expect(
      runWithToolContext(ctx, () =>
        Effect.runPromise(bashToolEffect("npm install express")),
      ),
    ).rejects.toThrow();
  });
});
