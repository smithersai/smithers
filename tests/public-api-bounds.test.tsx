/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { SmithersDb, runWorkflow } from "../src/index";
import {
  DB_RUN_ALLOWED_STATUSES,
  DB_RUN_WORKFLOW_NAME_MAX_LENGTH,
} from "../src/db/adapter";
import {
  GATEWAY_METHOD_NAME_MAX_LENGTH,
  GATEWAY_RPC_MAX_ARRAY_LENGTH,
  GATEWAY_RPC_MAX_DEPTH,
  GATEWAY_RPC_MAX_PAYLOAD_BYTES,
  Gateway,
  parseGatewayRequestFrame,
  validateGatewayMethodName,
} from "../src/gateway";
import {
  RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH,
  RUN_WORKFLOW_INPUT_MAX_BYTES,
  RUN_WORKFLOW_INPUT_MAX_DEPTH,
  RUN_WORKFLOW_RUN_ID_MAX_LENGTH,
} from "../src/engine";
import {
  SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH,
  SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH,
  SANDBOX_MAX_BUNDLE_BYTES,
  SANDBOX_MAX_PATCH_FILES,
  validateSandboxBundle,
  writeSandboxBundle,
} from "../src/sandbox/bundle";
import {
  BASH_TOOL_MAX_ARGS,
  BASH_TOOL_MAX_COMMAND_LENGTH,
  bashToolEffect,
} from "../src/tools/bash";
import { ensureSmithersTables } from "../src/db/ensure";
import { runPromise } from "../src/effect/runtime";
import { runWithToolContext } from "../src/tools/context";
import { createTestDb, createTestSmithers } from "./helpers";
import { ddl, schema } from "./schema";

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

async function expectAsyncSmithersError(
  promise: Promise<unknown>,
  code = "INVALID_INPUT",
) {
  await expect(promise).rejects.toMatchObject({ code });
}

function expectSmithersError(fn: () => unknown, code = "INVALID_INPUT") {
  try {
    fn();
    throw new Error("Expected SmithersError");
  } catch (error: any) {
    expect(error?.code).toBe(code);
  }
}

function buildWorkflow() {
  const runtime = createTestSmithers({
    result: z.object({ value: z.number() }),
  });
  const workflow = runtime.smithers(() => (
    <runtime.Workflow name="bounds-workflow">
      <runtime.Task id="task" output={runtime.outputs.result}>
        {{ value: 1 }}
      </runtime.Task>
    </runtime.Workflow>
  ));
  return { ...runtime, workflow };
}

async function withBashContext<T>(
  rootDir: string,
  overrides: Partial<{ maxOutputBytes: number; timeoutMs: number }> = {},
  fn: () => Promise<T>,
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
        allowNetwork: true,
        maxOutputBytes: overrides.maxOutputBytes ?? 200_000,
        timeoutMs: overrides.timeoutMs ?? 5_000,
        seq: 0,
      },
      fn,
    );
  } finally {
    cleanup();
  }
}

describe("runWorkflow bounds", () => {
  test("rejects runIds that exceed the max length", async () => {
    const { workflow, cleanup } = buildWorkflow();
    try {
      await expectAsyncSmithersError(
        runWorkflow(workflow, {
          input: {},
          runId: "r".repeat(RUN_WORKFLOW_RUN_ID_MAX_LENGTH + 1),
        }),
      );
    } finally {
      cleanup();
    }
  });

  test("rejects input payloads that exceed the max byte budget", async () => {
    const { workflow, cleanup } = buildWorkflow();
    const chunk = "x".repeat(60_000);
    try {
      await expectAsyncSmithersError(
        runWorkflow(workflow, {
          input: {
            a: chunk,
            b: chunk,
            c: chunk,
            d: chunk,
            e: chunk,
          },
        }),
      );
    } finally {
      cleanup();
    }
    expect(Buffer.byteLength(JSON.stringify({
      a: chunk,
      b: chunk,
      c: chunk,
      d: chunk,
      e: chunk,
    }), "utf8")).toBeGreaterThan(RUN_WORKFLOW_INPUT_MAX_BYTES);
  });

  test("rejects input arrays that exceed the max length", async () => {
    const { workflow, cleanup } = buildWorkflow();
    try {
      await expectAsyncSmithersError(
        runWorkflow(workflow, {
          input: {
            values: Array.from(
              { length: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH + 1 },
              (_, index) => index,
            ),
          },
        }),
      );
    } finally {
      cleanup();
    }
  });

  test("rejects invalid numeric run options", async () => {
    const { workflow, cleanup } = buildWorkflow();
    try {
      for (const maxConcurrency of [0, -1, Number.POSITIVE_INFINITY]) {
        await expectAsyncSmithersError(
          runWorkflow(workflow, {
            input: {},
            maxConcurrency,
          }),
        );
      }
    } finally {
      cleanup();
    }
  });

  test("rejects input payloads that exceed the max depth", async () => {
    const { workflow, cleanup } = buildWorkflow();
    try {
      await expectAsyncSmithersError(
        runWorkflow(workflow, {
          input: nestedObject(RUN_WORKFLOW_INPUT_MAX_DEPTH + 1),
        }),
      );
    } finally {
      cleanup();
    }
  });
});

describe("db adapter bounds", () => {
  function createAdapter() {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db as any);
    return { adapter: new SmithersDb(db as any), cleanup };
  }

  test("rejects workflow names that exceed the max length", async () => {
    const { adapter, cleanup } = createAdapter();
    try {
      expectSmithersError(() =>
        adapter.insertRun({
          runId: "run-db-long-name",
          workflowName: "w".repeat(DB_RUN_WORKFLOW_NAME_MAX_LENGTH + 1),
          status: "running",
          createdAtMs: Date.now(),
        }),
      );
    } finally {
      cleanup();
    }
  });

  test("rejects unknown run statuses", async () => {
    const { adapter, cleanup } = createAdapter();
    try {
      expectSmithersError(() =>
        adapter.insertRun({
          runId: "run-db-bad-status",
          workflowName: "wf",
          status: "not-a-real-status",
          createdAtMs: Date.now(),
        }),
      );
    } finally {
      cleanup();
    }
    expect(DB_RUN_ALLOWED_STATUSES).not.toContain("not-a-real-status" as any);
  });

  test("rejects invalid numeric timestamps", async () => {
    const { adapter, cleanup } = createAdapter();
    try {
      for (const createdAtMs of [0, -1, Number.POSITIVE_INFINITY]) {
        expectSmithersError(() =>
          adapter.insertRun({
            runId: `run-db-ts-${String(createdAtMs)}`,
            workflowName: "wf",
            status: "running",
            createdAtMs,
          }),
        );
      }
    } finally {
      cleanup();
    }
  });
});

describe("gateway bounds", () => {
  test("rejects method names that exceed the max length", () => {
    expectSmithersError(() =>
      validateGatewayMethodName("m".repeat(GATEWAY_METHOD_NAME_MAX_LENGTH + 1)),
    );
  });

  test("rejects payloads that exceed the max byte size", () => {
    const frame = JSON.stringify({
      type: "req",
      id: "oversized",
      method: "runs.create",
      params: {
        payload: "x".repeat(GATEWAY_RPC_MAX_PAYLOAD_BYTES + 1),
      },
    });
    expectSmithersError(() => parseGatewayRequestFrame(frame));
  });

  test("rejects arrays that exceed the max payload size", () => {
    const frame = JSON.stringify({
      type: "req",
      id: "too-many-items",
      method: "runs.create",
      params: {
        items: Array.from(
          { length: GATEWAY_RPC_MAX_ARRAY_LENGTH + 1 },
          (_, index) => index,
        ),
      },
    });
    expectSmithersError(() => parseGatewayRequestFrame(frame));
  });

  test("rejects payloads that exceed the max depth", () => {
    const frame = JSON.stringify({
      type: "req",
      id: "too-deep",
      method: "runs.create",
      params: nestedObject(GATEWAY_RPC_MAX_DEPTH + 1),
    });
    expectSmithersError(() => parseGatewayRequestFrame(frame));
  });

  test("rejects invalid numeric gateway options", () => {
    for (const maxBodyBytes of [0, -1, Number.POSITIVE_INFINITY]) {
      expectSmithersError(() => new Gateway({ maxBodyBytes: maxBodyBytes as any }));
    }
  });
});

describe("sandbox bundle bounds", () => {
  test("rejects runIds that exceed the max length", async () => {
    const bundlePath = makeTempDir("smithers-sandbox-write-");
    try {
      await expectAsyncSmithersError(
        writeSandboxBundle({
          bundlePath,
          output: { ok: true },
          status: "finished",
          runId: "r".repeat(SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH + 1),
        }),
      );
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });

  test("rejects patch arrays that exceed the max size", async () => {
    const bundlePath = makeTempDir("smithers-sandbox-write-");
    try {
      await expectAsyncSmithersError(
        writeSandboxBundle({
          bundlePath,
          output: { ok: true },
          status: "finished",
          patches: Array.from({ length: SANDBOX_MAX_PATCH_FILES + 1 }, (_, index) => ({
            path: `patches/${index}.patch`,
            content: "diff --git a/a b/a\n",
          })),
        }),
      );
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });

  test("rejects output payloads that exceed the max depth", async () => {
    const bundlePath = makeTempDir("smithers-sandbox-write-");
    try {
      await expectAsyncSmithersError(
        writeSandboxBundle({
          bundlePath,
          output: nestedObject(SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH + 1),
          status: "finished",
        }),
      );
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });

  test("rejects bundles that exceed the max total size", async () => {
    const bundlePath = makeTempDir("smithers-sandbox-validate-");
    try {
      await writeSandboxBundle({
        bundlePath,
        output: { ok: true },
        status: "finished",
      });
      writeFileSync(join(bundlePath, "artifacts", "huge.bin"), "");
      truncateSync(
        join(bundlePath, "artifacts", "huge.bin"),
        SANDBOX_MAX_BUNDLE_BYTES + 1,
      );

      await expectAsyncSmithersError(validateSandboxBundle(bundlePath));
    } finally {
      rmSync(bundlePath, { recursive: true, force: true });
    }
  });
});

describe("bash tool bounds", () => {
  test("rejects commands that exceed the max length", async () => {
    const root = makeTempDir("smithers-bash-bounds-");
    try {
      await expectAsyncSmithersError(
        withBashContext(root, {}, () =>
          runPromise(
            bashToolEffect("x".repeat(BASH_TOOL_MAX_COMMAND_LENGTH + 1)),
          ),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects argument arrays that exceed the max size", async () => {
    const root = makeTempDir("smithers-bash-bounds-");
    try {
      await expectAsyncSmithersError(
        withBashContext(root, {}, () =>
          runPromise(
            bashToolEffect(
              "echo",
              Array.from({ length: BASH_TOOL_MAX_ARGS + 1 }, () => "x"),
            ),
          ),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid numeric tool context limits", async () => {
    const root = makeTempDir("smithers-bash-bounds-");
    try {
      for (const maxOutputBytes of [0, -1, Number.POSITIVE_INFINITY]) {
        await expectAsyncSmithersError(
          withBashContext(root, { maxOutputBytes }, () =>
            runPromise(bashToolEffect("echo", ["ok"])),
          ),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
