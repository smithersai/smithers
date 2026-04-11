import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Effect } from "effect";
import { renderPrometheusMetrics } from "@smithers/observability";
import { runWithToolContext } from "../src/context";
import { logToolCallEffect } from "../src/logToolCall";

function metricValue(name: string): number {
  const prefix = `${name} `;
  const line = renderPrometheusMetrics()
    .split("\n")
    .find((entry) => entry.startsWith(prefix));
  if (!line) return 0;
  return Number(line.slice(prefix.length));
}

describe("logToolCallEffect", () => {
  test("increments truncation metric when tool call payload previews are truncated", async () => {
    const before = metricValue("smithers_tool_output_truncated_total");

    await runWithToolContext(
      {
        db: {
          insertToolCallEffect: () => Effect.void,
        } as any,
        runId: "run",
        nodeId: "node",
        iteration: 0,
        attempt: 1,
        rootDir: process.cwd(),
        allowNetwork: false,
        maxOutputBytes: 64,
        timeoutMs: 1000,
        seq: 0,
      },
      () =>
        Effect.runPromise(
          logToolCallEffect(
            "test-tool",
            { input: "x".repeat(256) },
            { output: "y".repeat(256) },
            "success",
          ),
        ),
    );

    expect(metricValue("smithers_tool_output_truncated_total")).toBe(before + 2);
  });

  test("does not require a db tool-call insert implementation", async () => {
    await expect(
      runWithToolContext(
        {
          db: {} as any,
          runId: "run",
          nodeId: "node",
          iteration: 0,
          attempt: 1,
          rootDir: process.cwd(),
          allowNetwork: false,
          maxOutputBytes: 64,
          timeoutMs: 1000,
          seq: 0,
        },
        () =>
          Effect.runPromise(
            logToolCallEffect(
              "test-tool",
              { input: "ok" },
              { output: "ok" },
              "success",
            ),
          ),
      ),
    ).resolves.toBeUndefined();
  });
});
