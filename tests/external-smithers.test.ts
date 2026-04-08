import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runWorkflow } from "../src/engine";
import {
  createExternalSmithers,
  type HostNodeJson,
  type SerializedCtx,
} from "../src/external/create-external-smithers";

const schemas = {
  outputA: z.object({ value: z.number() }),
  outputB: z.object({ value: z.number() }),
};

function el(
  tag: string,
  rawProps: Record<string, any>,
  children: HostNodeJson[] = [],
): HostNodeJson {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      props[k] = String(v);
    }
  }
  return { kind: "element", tag, props, rawProps, children };
}

function txt(text: string): HostNodeJson {
  return { kind: "text", text };
}

describe("createExternalSmithers", () => {
  test("static task produces DB row", async () => {
    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: {},
      buildFn: () =>
        el("smithers:workflow", { name: "static" }, [
          el("smithers:task", {
            id: "t1",
            output: "outputA",
            __smithersKind: "static",
            __smithersPayload: { value: 42 },
          }),
        ]),
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("agent task resolves string agent name and invokes generate", async () => {
    let capturedPrompt = "";
    const mockAgent = {
      id: "mock",
      tools: {},
      generate: async (args: any) => {
        capturedPrompt = args.prompt;
        return { output: { value: 99 } };
      },
    };

    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: { myAgent: mockAgent },
      buildFn: () =>
        el("smithers:workflow", { name: "agent-test" }, [
          el(
            "smithers:task",
            {
              id: "a1",
              output: "outputA",
              agent: "myAgent",
              __smithersKind: "agent",
            },
            [txt("Analyze this code")],
          ),
        ]),
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");
    expect(capturedPrompt).toContain("Analyze this code");

    const rows = await (wf.db as any).select().from(wf.tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(99);
    cleanup();
  });

  test("buildFn receives updated outputs on re-render", async () => {
    const calls: SerializedCtx[] = [];

    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: {},
      buildFn: (ctx) => {
        calls.push(JSON.parse(JSON.stringify(ctx)));
        const hasA = (ctx.outputs.outputA ?? []).length > 0;

        const children: HostNodeJson[] = [
          el("smithers:task", {
            id: "a",
            output: "outputA",
            __smithersKind: "static",
            __smithersPayload: { value: 1 },
          }),
        ];

        if (hasA) {
          children.push(
            el("smithers:task", {
              id: "b",
              output: "outputB",
              __smithersKind: "static",
              __smithersPayload: { value: 2 },
            }),
          );
        }

        return el("smithers:workflow", { name: "rerender" }, children);
      },
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    // buildFn should be called at least twice: once initially, once after task A completes
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First call should have empty outputs
    expect(calls[0].outputs.outputA ?? []).toHaveLength(0);
    // Second call should have outputA populated
    const laterCall = calls.find((c) => (c.outputs.outputA ?? []).length > 0);
    expect(laterCall).toBeDefined();

    const rowsB = await (wf.db as any).select().from(wf.tables.outputB);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0].value).toBe(2);
    cleanup();
  });

  test("sequence executes tasks in order", async () => {
    const order: string[] = [];

    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: {},
      buildFn: () =>
        el("smithers:workflow", { name: "seq" }, [
          el("smithers:sequence", {}, [
            el("smithers:task", {
              id: "first",
              output: "outputA",
              __smithersKind: "compute",
              __smithersComputeFn: () => {
                order.push("first");
                return { value: 1 };
              },
            }),
            el("smithers:task", {
              id: "second",
              output: "outputB",
              __smithersKind: "compute",
              __smithersComputeFn: () => {
                order.push("second");
                return { value: 2 };
              },
            }),
          ]),
        ]),
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");
    expect(order).toEqual(["first", "second"]);
    cleanup();
  });

  test("parallel executes tasks concurrently", async () => {
    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: {},
      buildFn: () =>
        el("smithers:workflow", { name: "par" }, [
          el("smithers:parallel", {}, [
            el("smithers:task", {
              id: "p1",
              output: "outputA",
              __smithersKind: "static",
              __smithersPayload: { value: 10 },
            }),
            el("smithers:task", {
              id: "p2",
              output: "outputB",
              __smithersKind: "static",
              __smithersPayload: { value: 20 },
            }),
          ]),
        ]),
    });

    const result = await runWorkflow(wf, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (wf.db as any).select().from(wf.tables.outputA);
    const rowsB = await (wf.db as any).select().from(wf.tables.outputB);
    expect(rowsA[0].value).toBe(10);
    expect(rowsB[0].value).toBe(20);
    cleanup();
  });

  test("unknown agent throws descriptive error", () => {
    const { cleanup, ...wf } = createExternalSmithers({
      schemas,
      agents: { realAgent: { id: "real", tools: {}, generate: async () => ({}) } },
      buildFn: () =>
        el("smithers:workflow", { name: "err" }, [
          el("smithers:task", {
            id: "t1",
            output: "outputA",
            agent: "nonexistent",
            __smithersKind: "agent",
          }, [txt("prompt")]),
        ]),
    });

    expect(() => (wf as any).build({ runId: "x", iteration: 0, outputs: Object.assign(() => [], {}), input: {} })).toThrow(
      /nonexistent.*not in the agents registry.*realAgent/,
    );
    cleanup();
  });
});
