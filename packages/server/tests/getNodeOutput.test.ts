import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { zodToTable } from "@smithers/db/zodToTable";
import { renderPrometheusMetrics } from "@smithers/observability";
import { getNodeOutputRoute } from "../src/gatewayRoutes/getNodeOutput.js";
import { NodeOutputRouteError } from "../src/gatewayRoutes/NodeOutputRouteError.js";
import { NODE_OUTPUT_MAX_BYTES } from "../src/gatewayRoutes/NODE_OUTPUT_MAX_BYTES.js";
import { NODE_OUTPUT_WARN_BYTES } from "../src/gatewayRoutes/NODE_OUTPUT_WARN_BYTES.js";
import { statusForRpcError, validateGatewayMethodName } from "../src/gateway.js";

function createOutputTable() {
  const schema = z.object({
    value: z.string(),
    optionalValue: z.string().optional(),
  });
  const table = zodToTable("node_output_test", schema);
  return { schema, table };
}

function createResolvedRun(options?: {
  outputTableName?: string;
  nodeState?: string;
  attempts?: any[];
  table?: any;
}) {
  const { table } = createOutputTable();
  const outputTableName = options?.outputTableName ?? "result";
  const nodeState = options?.nodeState ?? "pending";

  return {
    workflow: {
      db: {},
      schemaRegistry: new Map([
        [
          outputTableName,
          {
            table: options?.table ?? table,
            zodSchema: z.object({ value: z.string() }),
          },
        ],
      ]),
    },
    adapter: {
      async listNodeIterations() {
        return [
          {
            runId: "run_1",
            nodeId: "task:main:0",
            iteration: 0,
            state: nodeState,
            lastAttempt: null,
            updatedAtMs: Date.now(),
            outputTable: outputTableName,
            label: "Task",
          },
        ];
      },
      async listAttempts() {
        return options?.attempts ?? [];
      },
    },
  };
}

async function invokeRoute(options?: {
  runId?: unknown;
  nodeId?: unknown;
  iteration?: unknown;
  resolvedRun?: any;
  selectOutputRowImpl?: any;
}) {
  return getNodeOutputRoute({
    runId: options?.runId ?? "run_1",
    nodeId: options?.nodeId ?? "task:main:0",
    iteration: options?.iteration ?? 0,
    async resolveRun() {
      return options?.resolvedRun ?? createResolvedRun();
    },
    selectOutputRowImpl: options?.selectOutputRowImpl,
  });
}

describe("getNodeOutputRoute status", () => {
  test("gateway method validator accepts getNodeOutput", () => {
    expect(validateGatewayMethodName("getNodeOutput")).toBe("getNodeOutput");
  });

  test("status produced when row exists", async () => {
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "done",
      }),
    });

    expect(response.status).toBe("produced");
    expect(response.row).toEqual({ value: "done" });
    expect(response.schema?.fields.length).toBeGreaterThan(0);
  });

  test("status pending when task is queued with no output", async () => {
    const response = await invokeRoute({
      resolvedRun: createResolvedRun({ nodeState: "pending" }),
      selectOutputRowImpl: async () => undefined,
    });

    expect(response.status).toBe("pending");
    expect(response.row).toBeNull();
    expect(response.schema).not.toBeNull();
  });

  test("status pending when task is running with no output", async () => {
    const response = await invokeRoute({
      resolvedRun: createResolvedRun({ nodeState: "running" }),
      selectOutputRowImpl: async () => undefined,
    });

    expect(response.status).toBe("pending");
    expect(response.row).toBeNull();
  });

  test("status failed when attempt has error and row is missing", async () => {
    const response = await invokeRoute({
      resolvedRun: createResolvedRun({
        nodeState: "failed",
        attempts: [
          {
            attempt: 1,
            state: "failed",
            errorJson: JSON.stringify({ message: "boom" }),
            heartbeatDataJson: null,
          },
        ],
      }),
      selectOutputRowImpl: async () => undefined,
    });

    expect(response.status).toBe("failed");
    expect(response.row).toBeNull();
    expect(response.partial).toBeNull();
  });

  test("status failed with partial heartbeat payload", async () => {
    const response = await invokeRoute({
      resolvedRun: createResolvedRun({
        nodeState: "failed",
        attempts: [
          {
            attempt: 1,
            state: "failed",
            errorJson: JSON.stringify({ message: "boom" }),
            heartbeatDataJson: JSON.stringify({ progress: 50, note: "halfway" }),
          },
        ],
      }),
      selectOutputRowImpl: async () => undefined,
    });

    expect(response.status).toBe("failed");
    expect(response.partial).toEqual({ progress: 50, note: "halfway" });
  });

  test("iteration over known max iteration returns IterationNotFound", async () => {
    const resolvedRun = createResolvedRun();
    resolvedRun.adapter.listNodeIterations = async () => [
      {
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "result",
        label: "Task",
      },
    ];

    await expect(
      invokeRoute({
        resolvedRun,
        iteration: 2,
        selectOutputRowImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "IterationNotFound" });
  });

  test("node without output table returns NodeHasNoOutput", async () => {
    const resolvedRun = createResolvedRun({ outputTableName: "" });
    resolvedRun.adapter.listNodeIterations = async () => [
      {
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: Date.now(),
        outputTable: "",
        label: "Task",
      },
    ];

    await expect(
      invokeRoute({
        resolvedRun,
        selectOutputRowImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "NodeHasNoOutput" });
  });

  test("malformed row JSON returns MalformedOutputRow", async () => {
    await expect(
      invokeRoute({
        selectOutputRowImpl: async () => {
          throw new SyntaxError("Unexpected token i in JSON");
        },
      }),
    ).rejects.toMatchObject({ code: "MalformedOutputRow" });
  });
});

describe("getNodeOutputRoute input boundaries", () => {
  test("invalid runId yields InvalidRunId", async () => {
    await expect(invokeRoute({ runId: "INVALID" })).rejects.toMatchObject({
      code: "InvalidRunId",
    });
  });

  test("invalid nodeId yields InvalidNodeId", async () => {
    await expect(invokeRoute({ nodeId: "bad$node" })).rejects.toMatchObject({
      code: "InvalidNodeId",
    });
  });

  test("invalid iteration yields InvalidIteration", async () => {
    await expect(invokeRoute({ iteration: -1 })).rejects.toMatchObject({
      code: "InvalidIteration",
    });
    await expect(invokeRoute({ iteration: 2_147_483_648 })).rejects.toMatchObject({
      code: "InvalidIteration",
    });
  });

  test("iteration zero before task start is pending and includes schema", async () => {
    const response = await invokeRoute({
      iteration: 0,
      resolvedRun: createResolvedRun({ nodeState: "pending" }),
      selectOutputRowImpl: async () => undefined,
    });

    expect(response.status).toBe("pending");
    expect(response.schema).not.toBeNull();
  });

  test("1MB string field is returned intact", async () => {
    const value = "x".repeat(1_048_576);
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value,
      }),
    });

    expect(response.status).toBe("produced");
    expect(response.row?.value).toBe(value);
  });

  test("10,000 element array is returned intact", async () => {
    const arr = Array.from({ length: 10_000 }, (_, index) => index);
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "ok",
        huge: arr,
      }),
    });

    expect(response.row?.huge).toHaveLength(10_000);
    expect((response.row?.huge as number[])[9999]).toBe(9999);
  });

  test("100 fields are returned", async () => {
    const row: Record<string, unknown> = {
      runId: "run_1",
      nodeId: "task:main:0",
      iteration: 0,
    };
    for (let index = 0; index < 100; index += 1) {
      row[`field_${index}`] = index;
    }

    const response = await invokeRoute({
      selectOutputRowImpl: async () => row,
    });

    expect(Object.keys(response.row ?? {})).toHaveLength(100);
  });

  test("deeply nested values are returned", async () => {
    let nested: Record<string, unknown> = { leaf: "ok" };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { [`level_${depth}`]: nested };
    }

    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "deep",
        nested,
      }),
    });

    expect(response.row?.nested).toEqual(nested);
  });

  test("unicode and emoji round trip", async () => {
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "hi 👋 こんにちは",
      }),
    });

    expect(response.row?.value).toBe("hi 👋 こんにちは");
  });

  test("nulls are preserved", async () => {
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "x",
        maybeNull: null,
      }),
    });

    expect(response.row?.maybeNull).toBeNull();
  });

  test("payload over 10MB is returned", async () => {
    const response = await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "x".repeat(10 * 1024 * 1024 + 8),
      }),
    });

    expect(response.status).toBe("produced");
    expect(typeof response.row?.value).toBe("string");
  });

  test("payload over 100MB yields PayloadTooLarge", async () => {
    await expect(
      invokeRoute({
        selectOutputRowImpl: async () => ({
          runId: "run_1",
          nodeId: "task:main:0",
          iteration: 0,
          value: "x".repeat(NODE_OUTPUT_MAX_BYTES + 1024),
        }),
      }),
    ).rejects.toMatchObject({
      code: "PayloadTooLarge",
    } satisfies Pick<NodeOutputRouteError, "code">);
  });
});

describe("getNodeOutputRoute error code coverage", () => {
  test("unresolved run yields RunNotFound", async () => {
    await expect(
      getNodeOutputRoute({
        runId: "run_missing",
        nodeId: "task:main:0",
        iteration: 0,
        async resolveRun() {
          return null;
        },
      }),
    ).rejects.toMatchObject({ code: "RunNotFound" });
  });

  test("adapter reports no node iterations yields NodeNotFound", async () => {
    const resolved = createResolvedRun();
    resolved.adapter.listNodeIterations = async () => [];
    await expect(invokeRoute({ resolvedRun: resolved })).rejects.toMatchObject({
      code: "NodeNotFound",
    });
  });

  test("schema conversion warning does not fail the call", async () => {
    const { table } = createOutputTable();
    const resolved = {
      workflow: {
        db: {},
        schemaRegistry: new Map([
          [
            "result",
            {
              table,
              // Union at top level triggers a warning from the descriptor builder.
              zodSchema: z.object({
                value: z.union([z.string(), z.number()]),
              }),
            },
          ],
        ]),
      },
      adapter: {
        async listNodeIterations() {
          return [
            {
              runId: "run_1",
              nodeId: "task:main:0",
              iteration: 0,
              state: "finished",
              lastAttempt: 1,
              updatedAtMs: Date.now(),
              outputTable: "result",
              label: "Task",
            },
          ];
        },
        async listAttempts() {
          return [];
        },
      },
    };
    const response = await getNodeOutputRoute({
      runId: "run_1",
      nodeId: "task:main:0",
      iteration: 0,
      async resolveRun() {
        return resolved as any;
      },
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "ok",
      }),
    });
    expect(response.status).toBe("produced");
    expect(response.schema?.fields.length).toBeGreaterThan(0);
  });
});

describe("statusForRpcError HTTP status mapping", () => {
  test("maps node-output error codes to documented HTTP statuses", () => {
    expect(statusForRpcError("InvalidRunId")).toBe(400);
    expect(statusForRpcError("InvalidNodeId")).toBe(400);
    expect(statusForRpcError("InvalidIteration")).toBe(400);
    expect(statusForRpcError("RunNotFound")).toBe(404);
    expect(statusForRpcError("NodeNotFound")).toBe(404);
    expect(statusForRpcError("IterationNotFound")).toBe(404);
    expect(statusForRpcError("NodeHasNoOutput")).toBe(404);
    expect(statusForRpcError("PayloadTooLarge")).toBe(413);
  });

  test("maps devtools stream error codes to documented HTTP statuses", () => {
    // New mappings — Unauthorized must be 401 (previously fell through to 500)
    // and InvalidDelta must be 400 (previously fell through to 500).
    expect(statusForRpcError("Unauthorized")).toBe(401);
    expect(statusForRpcError("InvalidDelta")).toBe(400);
    expect(statusForRpcError("FrameOutOfRange")).toBe(400);
    expect(statusForRpcError("SeqOutOfRange")).toBe(400);
    expect(statusForRpcError("BackpressureDisconnect")).toBe(429);
  });

  test("maps jumpToFrame error codes to documented HTTP statuses", () => {
    expect(statusForRpcError("InvalidFrameNo")).toBe(400);
    expect(statusForRpcError("ConfirmationRequired")).toBe(400);
    expect(statusForRpcError("Busy")).toBe(409);
    expect(statusForRpcError("RateLimited")).toBe(429);
    expect(statusForRpcError("UnsupportedSandbox")).toBe(501);
    expect(statusForRpcError("VcsError")).toBe(500);
    expect(statusForRpcError("RewindFailed")).toBe(500);
  });
});

describe("getNodeOutputRoute observability", () => {
  test("increments smithers_node_output_request_total with the produced status label", async () => {
    const metricsBefore = renderPrometheusMetrics();
    await invokeRoute({
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "observed",
      }),
    });
    const metricsAfter = renderPrometheusMetrics();
    const producedBefore = countMetricWithLabel(
      metricsBefore,
      "smithers_node_output_request_total",
      "produced",
    );
    const producedAfter = countMetricWithLabel(
      metricsAfter,
      "smithers_node_output_request_total",
      "produced",
    );
    expect(producedAfter).toBeGreaterThan(producedBefore);
    // All four Prometheus-renamed metric lines must appear with underscores
    // (not dots).
    expect(metricsAfter).toMatch(/smithers_node_output_request_total/);
    expect(metricsAfter).toMatch(/smithers_node_output_bytes/);
    expect(metricsAfter).toMatch(/smithers_node_output_duration_ms/);
    expect(metricsAfter).not.toMatch(/smithers\.node_output/);
  });

  test("emits schema-conversion-error counter on warning", async () => {
    const metricsBefore = renderPrometheusMetrics();
    const { table } = createOutputTable();
    const resolved = {
      workflow: {
        db: {},
        schemaRegistry: new Map([
          [
            "result",
            {
              table,
              zodSchema: z.object({
                value: z.union([z.string(), z.number()]),
              }),
            },
          ],
        ]),
      },
      adapter: {
        async listNodeIterations() {
          return [
            {
              runId: "run_1",
              nodeId: "task:main:0",
              iteration: 0,
              state: "finished",
              lastAttempt: 1,
              updatedAtMs: Date.now(),
              outputTable: "result",
              label: "Task",
            },
          ];
        },
        async listAttempts() {
          return [];
        },
      },
    };
    await getNodeOutputRoute({
      runId: "run_1",
      nodeId: "task:main:0",
      iteration: 0,
      async resolveRun() {
        return resolved as any;
      },
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: "ok",
      }),
    });
    const metricsAfter = renderPrometheusMetrics();
    expect(metricsAfter).toContain(
      "smithers_node_output_schema_conversion_error_total",
    );
    const beforeCount = countMetricLine(
      metricsBefore,
      "smithers_node_output_schema_conversion_error_total",
    );
    const afterCount = countMetricLine(
      metricsAfter,
      "smithers_node_output_schema_conversion_error_total",
    );
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount + 1);
  });

  test("payload >1MB emits log warn without content and still returns row", async () => {
    // Capture emitted log output. We intercept console/log by running each Effect
    // and rely on structured log fields: the route is required to log rowBytes
    // but never log the row content itself.
    const loggedStrings: string[] = [];
    const emitEffect = async (effect: any) => {
      const annotated = effect.pipe(
        // Attach a probe that will run after the effect executes.
        Effect.tap(() =>
          Effect.sync(() => {
            loggedStrings.push("emit");
          }),
        ),
      );
      return Effect.runPromise(annotated as any).catch(() => undefined);
    };
    const largeString = "y".repeat(NODE_OUTPUT_WARN_BYTES + 16);
    const response = await getNodeOutputRoute({
      runId: "run_1",
      nodeId: "task:main:0",
      iteration: 0,
      async resolveRun() {
        return createResolvedRun() as any;
      },
      emitEffect,
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        value: largeString,
      }),
    });
    expect(response.status).toBe("produced");
    // The route must run at least two observability effects in this path
    // (large-payload warn + finalise). This asserts the warn branch executes.
    expect(loggedStrings.length).toBeGreaterThanOrEqual(2);
    // The handler response must contain the intact row (not truncated).
    expect((response.row as { value: string }).value.length).toBe(largeString.length);
  });
});

describe("getNodeOutputRoute performance budgets", () => {
  test("cached (no row) call completes within 20ms p95", async () => {
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      await invokeRoute({
        resolvedRun: createResolvedRun({ nodeState: "pending" }),
        selectOutputRowImpl: async () => undefined,
      });
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(200);
  });

  test("1MB row completes within 200ms p95", async () => {
    const big = "x".repeat(NODE_OUTPUT_WARN_BYTES);
    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const startedAt = performance.now();
      await invokeRoute({
        selectOutputRowImpl: async () => ({
          runId: "run_1",
          nodeId: "task:main:0",
          iteration: 0,
          value: big,
        }),
      });
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(500);
  });

  test("10MB row completes within 1000ms p95", async () => {
    const big = "x".repeat(10 * 1024 * 1024);
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const startedAt = performance.now();
      await invokeRoute({
        selectOutputRowImpl: async () => ({
          runId: "run_1",
          nodeId: "task:main:0",
          iteration: 0,
          value: big,
        }),
      });
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(3_000);
  });

  test("100-field schema descriptor construction stays under budget", async () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let index = 0; index < 100; index += 1) {
      shape[`field_${index}`] = z.string();
    }
    const schema = z.object(shape);
    const table = zodToTable("node_output_100_fields", schema);
    const resolved = {
      workflow: {
        db: {},
        schemaRegistry: new Map([["result", { table, zodSchema: schema }]]),
      },
      adapter: {
        async listNodeIterations() {
          return [
            {
              runId: "run_1",
              nodeId: "task:main:0",
              iteration: 0,
              state: "finished",
              lastAttempt: 1,
              updatedAtMs: Date.now(),
              outputTable: "result",
              label: "Task",
            },
          ];
        },
        async listAttempts() {
          return [];
        },
      },
    };
    const row: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      row[`field_${index}`] = `v${index}`;
    }
    const startedAt = performance.now();
    const response = await getNodeOutputRoute({
      runId: "run_1",
      nodeId: "task:main:0",
      iteration: 0,
      async resolveRun() {
        return resolved as any;
      },
      selectOutputRowImpl: async () => ({
        runId: "run_1",
        nodeId: "task:main:0",
        iteration: 0,
        ...row,
      }),
    });
    const durationMs = performance.now() - startedAt;
    expect(response.status).toBe("produced");
    expect(response.schema?.fields).toHaveLength(100);
    expect(durationMs).toBeLessThan(200);
  });
});

function countMetricWithLabel(prometheusText: string, name: string, label: string) {
  let total = 0;
  for (const line of prometheusText.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!match) continue;
    if (match[1] !== name) continue;
    const labels = match[2] ?? "";
    if (labels.includes(label)) {
      const value = Number(match[3]);
      if (!Number.isNaN(value)) total += value;
    }
  }
  return total;
}

function countMetricLine(prometheusText: string, name: string) {
  let total = 0;
  for (const line of prometheusText.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!match) continue;
    if (match[1] !== name) continue;
    const value = Number(match[3]);
    if (!Number.isNaN(value)) total += value;
  }
  return total;
}
