import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { createPythonWorkflow } from "../src/external/python";
import { runWorkflow } from "../src/engine";

let hasUv = false;
beforeAll(() => {
  try {
    execSync("uv --version", { stdio: "pipe" });
    hasUv = true;
  } catch {
    console.error("uv not found, skipping python tests")
    hasUv = false;
  }
});

const fixturesDir = resolve(import.meta.dir, "fixtures");
const sdkPath = resolve(import.meta.dir, "../packages/smithers-py");

const schemas = {
  outputA: z.object({ value: z.number() }),
  outputB: z.object({ value: z.number() }),
};

function pythonWf(scriptName: string, agents: Record<string, any> = {}) {
  return createPythonWorkflow({
    scriptPath: resolve(fixturesDir, scriptName),
    schemas,
    agents,
    env: { PYTHONPATH: sdkPath },
  });
}

describe("Python E2E", () => {
  test("static task: SDK workflow produces DB row", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pythonWf("sdk-static-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("agent task: mock agent receives prompt from Python", async () => {
    if (!hasUv) return;
    let capturedPrompt = "";
    const mockAgent = {
      id: "mock",
      tools: {},
      generate: async (args: any) => {
        capturedPrompt = args.prompt;
        return { output: { value: 77 } };
      },
    };

    const { cleanup, ...wf } = pythonWf("sdk-agent-workflow.py", { mock: mockAgent });

    const result = await runWorkflow(wf, { input: { topic: "quantum" } });
    expect(result.status).toBe("finished");
    expect(capturedPrompt).toContain("Analyze: quantum");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(77);
    cleanup();
  });

  test("loop: iterates until condition met", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pythonWf("sdk-loop-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    // Loop runs twice: iteration 0 (value=0) and iteration 1 (value=1)
    expect(rows.length).toBe(2);
    // Sort by iteration to verify
    const sorted = rows.sort((a: any, b: any) => a.iteration - b.iteration);
    expect(sorted[0].value).toBe(0);
    expect(sorted[1].value).toBe(1);
    cleanup();
  });

  test("conditional: task B only mounts after task A completes", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pythonWf("sdk-conditional-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (wf.db as any).select().from(wf.tables.outputA);
    const rowsB = await (wf.db as any).select().from(wf.tables.outputB);
    expect(rowsA.length).toBe(1);
    expect(rowsA[0].value).toBe(1);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].value).toBe(2);
    cleanup();
  });

  test("parallel: both tasks complete", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pythonWf("sdk-parallel-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (wf.db as any).select().from(wf.tables.outputA);
    const rowsB = await (wf.db as any).select().from(wf.tables.outputB);
    expect(rowsA.length).toBe(1);
    expect(rowsA[0].value).toBe(10);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].value).toBe(20);
    cleanup();
  });
});
