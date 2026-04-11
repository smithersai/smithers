import { describe, expect, test } from "bun:test";
import React from "react";
import { extractFromHost, type HostElement, type HostText, type HostNode } from "@smithers/graph/dom/extract";
import { SmithersRenderer } from "../src/dom/renderer";
import { runWorkflow } from "@smithers/engine";
import { createTestSmithers } from "../../smithers/tests/helpers";
import { z } from "zod";

const schemas = {
  outputA: z.object({ value: z.number() }),
  outputB: z.object({ value: z.number() }),
};

/**
 * Helper: build a HostElement node (the shape extractFromHost expects).
 */
function hostEl(
  tag: string,
  rawProps: Record<string, any>,
  children: HostNode[] = [],
): HostElement {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      props[k] = String(v);
    }
  }
  return { kind: "element", tag, props, rawProps, children };
}

function hostText(text: string): HostText {
  return { kind: "text", text };
}

/**
 * Recursively convert a HostNode JSON tree into React elements,
 * the same way the external adapter will.
 */
function hostNodeToReact(node: HostNode): React.ReactNode {
  if (node.kind === "text") return node.text;
  const children = node.children.map(hostNodeToReact);
  return React.createElement(node.tag, node.rawProps, ...children);
}

describe("extractFromHost with string output keys", () => {
  test("extracts task with string output key", () => {
    const root = hostEl("smithers:workflow", { name: "test" }, [
      hostEl("smithers:task", {
        id: "t1",
        output: "outputA",
        __smithersKind: "static",
        __smithersPayload: { value: 42 },
      }),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("t1");
    expect(result.tasks[0].outputTableName).toBe("outputA");
    expect(result.tasks[0].outputTable).toBeNull();
  });

  test("extracts multiple tasks in sequence with string output keys", () => {
    const root = hostEl("smithers:workflow", { name: "test" }, [
      hostEl("smithers:sequence", {}, [
        hostEl("smithers:task", {
          id: "a",
          output: "outputA",
          __smithersKind: "static",
          __smithersPayload: { value: 1 },
        }),
        hostEl("smithers:task", {
          id: "b",
          output: "outputB",
          __smithersKind: "static",
          __smithersPayload: { value: 2 },
        }),
      ]),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].outputTableName).toBe("outputA");
    expect(result.tasks[1].outputTableName).toBe("outputB");
  });

  test("extracts tasks inside parallel group", () => {
    const root = hostEl("smithers:workflow", { name: "test" }, [
      hostEl("smithers:parallel", { maxConcurrency: 2 }, [
        hostEl("smithers:task", {
          id: "p1",
          output: "outputA",
          __smithersKind: "static",
          __smithersPayload: { value: 10 },
        }),
        hostEl("smithers:task", {
          id: "p2",
          output: "outputB",
          __smithersKind: "static",
          __smithersPayload: { value: 20 },
        }),
      ]),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(2);
    // Both should share a parallel group
    expect(result.tasks[0].parallelGroupId).toBeDefined();
    expect(result.tasks[0].parallelGroupId).toBe(result.tasks[1].parallelGroupId);
    expect(result.tasks[0].parallelMaxConcurrency).toBe(2);
  });

  test("extracts tasks inside ralph (loop)", () => {
    const root = hostEl("smithers:workflow", { name: "test" }, [
      hostEl("smithers:ralph", { id: "myloop", until: false, maxIterations: 3 }, [
        hostEl("smithers:task", {
          id: "step",
          output: "outputA",
          __smithersKind: "static",
          __smithersPayload: { value: 0 },
        }),
      ]),
    ]);

    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("step");
    expect(result.tasks[0].ralphId).toBe("myloop");
    expect(result.tasks[0].iteration).toBe(0);
  });

  test("React round-trip: HostNode → React.createElement → renderer → same extraction", async () => {
    const hostTree = hostEl("smithers:workflow", { name: "rt" }, [
      hostEl("smithers:task", {
        id: "t1",
        output: "outputA",
        __smithersKind: "static",
        __smithersPayload: { value: 99 },
      }),
    ]);

    // Direct extraction from HostNode
    const directResult = extractFromHost(hostTree);

    // React round-trip
    const reactEl = hostNodeToReact(hostTree) as React.ReactElement;
    const renderer = new SmithersRenderer();
    const renderedResult = await renderer.render(reactEl);

    // Compare task descriptors
    expect(renderedResult.tasks).toHaveLength(directResult.tasks.length);
    expect(renderedResult.tasks[0].nodeId).toBe(directResult.tasks[0].nodeId);
    expect(renderedResult.tasks[0].outputTableName).toBe(directResult.tasks[0].outputTableName);
    expect(renderedResult.tasks[0].staticPayload).toEqual(directResult.tasks[0].staticPayload);
  });

  test("full round-trip: HostNode-based SmithersWorkflow through runWorkflow", async () => {
    const { smithers, db, tables, cleanup } = createTestSmithers(schemas);

    // Create a dummy workflow to extract schemaRegistry and zodToKeyName
    const dummy = smithers(() => React.createElement("smithers:workflow", { name: "x" }));
    const { schemaRegistry, zodToKeyName } = dummy as any;

    // Build a SmithersWorkflow whose build() returns React elements from HostNode JSON
    const workflow = {
      db,
      build: (_ctx: any) => {
        const hostTree = hostEl("smithers:workflow", { name: "external" }, [
          hostEl("smithers:task", {
            id: "t1",
            output: "outputA",
            __smithersKind: "static",
            __smithersPayload: { value: 42 },
          }),
        ]);
        return hostNodeToReact(hostTree) as React.ReactElement;
      },
      opts: {},
      schemaRegistry,
      zodToKeyName,
    };

    const result = await runWorkflow(workflow as any, { input: {} });
    expect(result.status).toBe("finished");

    const rows = await (db as any).select().from(tables.outputA);
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe(42);
    cleanup();
  });

  test("full round-trip with sequence", async () => {
    const { smithers, db, tables, cleanup } = createTestSmithers(schemas);
    const dummy = smithers(() => React.createElement("smithers:workflow", { name: "x" }));
    const { schemaRegistry, zodToKeyName } = dummy as any;

    const workflow = {
      db,
      build: (_ctx: any) => {
        const hostTree = hostEl("smithers:workflow", { name: "seq-ext" }, [
          hostEl("smithers:sequence", {}, [
            hostEl("smithers:task", {
              id: "a",
              output: "outputA",
              __smithersKind: "static",
              __smithersPayload: { value: 1 },
            }),
            hostEl("smithers:task", {
              id: "b",
              output: "outputB",
              __smithersKind: "static",
              __smithersPayload: { value: 2 },
            }),
          ]),
        ]);
        return hostNodeToReact(hostTree) as React.ReactElement;
      },
      opts: {},
      schemaRegistry,
      zodToKeyName,
    };

    const result = await runWorkflow(workflow as any, { input: {} });
    expect(result.status).toBe("finished");

    const rowsA = await (db as any).select().from(tables.outputA);
    const rowsB = await (db as any).select().from(tables.outputB);
    expect(rowsA[0].value).toBe(1);
    expect(rowsB[0].value).toBe(2);
    cleanup();
  });
});
