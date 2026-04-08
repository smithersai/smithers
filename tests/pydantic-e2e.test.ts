import { describe, expect, test, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { createPythonWorkflow } from "../src/external/python";
import { discoverPythonSchemas } from "../src/external/python-subprocess";
import { runWorkflow } from "../src/engine";

let hasUv = false;
beforeAll(() => {
  try {
    execSync("uv --version", { stdio: "pipe" });
    hasUv = true;
  } catch {
    hasUv = false;
  }
});

const fixturesDir = resolve(import.meta.dir, "fixtures");
const sdkPath = resolve(import.meta.dir, "../packages/smithers-py");
const env = { PYTHONPATH: sdkPath };

function pydanticWf(scriptName: string, agents: Record<string, any> = {}) {
  return createPythonWorkflow({
    scriptPath: resolve(fixturesDir, scriptName),
    agents,
    env,
  });
}

describe("Pydantic schema auto-discovery", () => {
  test("discoverPythonSchemas returns JSON Schema keyed by snake_cased class name", () => {
    if (!hasUv) return;
    const schemas = discoverPythonSchemas({
      scriptPath: resolve(fixturesDir, "pydantic-static-workflow.py"),
      env,
    });

    // OutputA class → "output_a" key
    expect(schemas).toHaveProperty("output_a");
    expect(schemas.output_a.type).toBe("object");
    expect(schemas.output_a.properties.value.type).toBe("integer");
  });

  test("static task with Pydantic model as output", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pydanticWf("pydantic-static-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    // Table key is "output_a" (from OutputA class name)
    const rows = await (wf.db as any).select().from(wf.tables.output_a);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("agent task with Agent sentinel and Pydantic model", async () => {
    if (!hasUv) return;
    let capturedPrompt = "";
    const mockAgent = {
      id: "mock",
      tools: {},
      generate: async (args: any) => {
        capturedPrompt = args.prompt;
        return { output: { summary: "Found 3 issues", issues: ["bug1", "bug2", "bug3"] } };
      },
    };

    const { cleanup, ...wf } = pydanticWf("pydantic-agent-workflow.py", { mock: mockAgent });

    const result = await runWorkflow(wf, { input: { topic: "security" } });
    expect(result.status).toBe("finished");
    expect(capturedPrompt).toContain("Analyze: security");

    const rows = await (wf.db as any).select().from(wf.tables.analysis);
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe("Found 3 issues");
    cleanup();
  });

  test("multiple Pydantic models auto-discovered", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = pydanticWf("pydantic-multi-schema-workflow.py");

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const research = await (wf.db as any).select().from(wf.tables.research);
    const report = await (wf.db as any).select().from(wf.tables.report);
    expect(research.length).toBe(1);
    expect(research[0].summary).toBe("AI is great");
    expect(report.length).toBe(1);
    expect(report[0].title).toBe("AI Report");
    cleanup();
  });

  test("explicit Zod schemas override auto-discovery", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = createPythonWorkflow({
      scriptPath: resolve(fixturesDir, "pydantic-static-workflow.py"),
      schemas: { output_a: z.object({ value: z.number() }) },
      agents: {},
      env,
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.output_a);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("backward compat: non-Pydantic workflow with explicit schemas", async () => {
    if (!hasUv) return;
    const { cleanup, ...wf } = createPythonWorkflow({
      scriptPath: resolve(fixturesDir, "echo-workflow.py"),
      schemas: { outputA: z.object({ value: z.number() }) },
      agents: {},
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows[0].value).toBe(42);
    cleanup();
  });
});
