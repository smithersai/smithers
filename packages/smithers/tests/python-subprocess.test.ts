import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { z } from "zod";
import { createPythonBuildFn } from "../src/external/python-subprocess";
import { createExternalSmithers, type SerializedCtx } from "../src/external/create-external-smithers";
import { runWorkflow } from "@smithers/engine";

// Skip all tests if uv is not available
let hasUv = false;
beforeAll(() => {
  try {
    execSync("uv --version", { stdio: "pipe" });
    hasUv = true;
  } catch {
    hasUv = false;
  }
});

const fixturesDir = new URL("./fixtures/", import.meta.url).pathname;

const emptyCtx: SerializedCtx = {
  runId: "test-run",
  iteration: 0,
  iterations: {},
  input: {},
  outputs: {},
};

describe("createPythonBuildFn", () => {
  test("happy path: echo-workflow returns valid HostNode", () => {
    if (!hasUv) return;
    const buildFn = createPythonBuildFn({ scriptPath: `${fixturesDir}echo-workflow.py` });
    const result = buildFn(emptyCtx);

    expect(result.kind).toBe("element");
    expect((result as any).tag).toBe("smithers:workflow");
    expect((result as any).children).toHaveLength(1);
    expect((result as any).children[0].rawProps.id).toBe("echo");
    expect((result as any).children[0].rawProps.__smithersPayload).toEqual({ value: 42 });
  });

  test("context passthrough: ctx-echo reads input.topic", () => {
    if (!hasUv) return;
    const buildFn = createPythonBuildFn({ scriptPath: `${fixturesDir}ctx-echo.py` });
    const ctx: SerializedCtx = {
      ...emptyCtx,
      input: { topic: "quantum" },
    };
    const result = buildFn(ctx);

    // ctx-echo.py returns value = len(topic) = len("quantum") = 7
    const taskNode = (result as any).children[0];
    expect(taskNode.rawProps.__smithersPayload.value).toBe(7);
  });

  test("error handling: non-zero exit code", () => {
    if (!hasUv) return;
    const buildFn = createPythonBuildFn({ scriptPath: `${fixturesDir}error-workflow.py` });

    expect(() => buildFn(emptyCtx)).toThrow(/exited with code 1/);
    expect(() => buildFn(emptyCtx)).toThrow(/Something went wrong/);
  });

  test("bad JSON: invalid output", () => {
    if (!hasUv) return;
    const buildFn = createPythonBuildFn({ scriptPath: `${fixturesDir}bad-json.py` });

    expect(() => buildFn(emptyCtx)).toThrow(/invalid JSON/);
  });

  test("integration: Python subprocess through full engine pipeline", async () => {
    if (!hasUv) return;

    const schemas = {
      outputA: z.object({ value: z.number() }),
    };

    const buildFn = createPythonBuildFn({ scriptPath: `${fixturesDir}echo-workflow.py` });
    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: {},
      buildFn,
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });
});
