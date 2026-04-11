/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { jsx, jsxs } from "smithers/jsx-runtime";
import { SmithersDb, runWorkflow, signalRun } from "smithers";
import { renderPrometheusMetrics } from "@smithers/observability";
import { createTestSmithers } from "./helpers";

function asyncPendingMetric(kind: "approval" | "event"): number {
  const text = renderPrometheusMetrics();
  const match = text.match(
    new RegExp(
      `^smithers_external_wait_async_pending\\{kind="${kind}"\\} ([^\\n]+)$`,
      "m",
    ),
  );
  return match ? Number(match[1]) : 0;
}

describe("Signal component", () => {
  test("blocks, validates delivered data, and renders typed children after resume", async () => {
    const { smithers, Signal, Workflow, Task, outputs, tables, db, cleanup } =
      createTestSmithers({
        feedback: z.object({
          rating: z.number(),
          comment: z.string(),
        }),
        result: z.object({
          rating: z.number(),
          summary: z.string(),
        }),
      });

    try {
      const seenPayloads: Array<Record<string, unknown>> = [];
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "signal-component-children",
          children: jsx(Signal, {
            id: "user-feedback",
            schema: outputs.feedback,
            children: (data: any) => {
              seenPayloads.push(data);
              return jsx(Task, {
                id: "process-feedback",
                output: outputs.result,
                children: {
                  rating: data.rating,
                  summary: data.comment.toUpperCase(),
                },
              });
            },
          }),
        }),
      );

      const first = await runWorkflow(workflow, { input: {} });
      expect(first.status).toBe("waiting-event");
      expect(seenPayloads).toEqual([]);

      await signalRun(
        new SmithersDb(db as any),
        first.runId,
        "user-feedback",
        { rating: 5, comment: "great" },
      );

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });

      expect(resumed.status).toBe("finished");
      expect(seenPayloads.at(-1)).toEqual({
        rating: 5,
        comment: "great",
      });
      expect(seenPayloads.some((payload) => "runId" in payload)).toBe(false);

      const signalRows = await (db as any).select().from(tables.feedback);
      expect(signalRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "user-feedback",
          iteration: 0,
          rating: 5,
          comment: "great",
        }),
      ]);

      const resultRows = await (db as any).select().from(tables.result);
      expect(resultRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "process-feedback",
          iteration: 0,
          rating: 5,
          summary: "GREAT",
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("can act as a blocking wait for downstream deps", async () => {
    const {
      smithers,
      Sequence,
      Signal,
      Workflow,
      Task,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      signalData: z.object({ value: z.number() }),
      result: z.object({
        value: z.number(),
        doubled: z.number(),
      }),
    });

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "signal-component-deps",
          children: jsxs(Sequence, {
            children: [
              jsx(Signal, {
                id: "new-data",
                schema: outputs.signalData,
              }),
              jsx(Task, {
                id: "after-signal",
                output: outputs.result,
                deps: { data: outputs.signalData },
                needs: { data: "new-data" },
                children: ({ data }: { data: any }) => ({
                  value: data.value,
                  doubled: data.value * 2,
                }),
              }),
            ],
          }),
        }),
      );

      const first = await runWorkflow(workflow, { input: {} });
      expect(first.status).toBe("waiting-event");

      const beforeRows = await (db as any).select().from(tables.result);
      expect(beforeRows).toEqual([]);

      await signalRun(
        new SmithersDb(db as any),
        first.runId,
        "new-data",
        { value: 7 },
      );

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });

      expect(resumed.status).toBe("finished");

      const resultRows = await (db as any).select().from(tables.result);
      expect(resultRows).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "after-signal",
          iteration: 0,
          value: 7,
          doubled: 14,
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("async signals allow unrelated downstream work before the signal arrives", async () => {
    const {
      smithers,
      Sequence,
      Signal,
      Workflow,
      Task,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      signalData: z.object({ value: z.number() }),
      result: z.object({ value: z.number() }),
    });

    try {
      const metricBefore = asyncPendingMetric("event");
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "signal-component-async",
          children: jsxs(Sequence, {
            children: [
              jsx(Signal, {
                id: "new-data",
                schema: outputs.signalData,
                async: true,
              }),
              jsx(Task, {
                id: "after-signal",
                output: outputs.result,
                children: {
                  value: 7,
                },
              }),
            ],
          }),
        }),
      );

      const first = await runWorkflow(workflow, { input: {} });
      expect(first.status).toBe("waiting-event");
      expect(asyncPendingMetric("event") - metricBefore).toBe(1);

      const resultRowsBeforeSignal = await (db as any).select().from(tables.result);
      expect(resultRowsBeforeSignal).toEqual([
        expect.objectContaining({
          runId: first.runId,
          nodeId: "after-signal",
          iteration: 0,
          value: 7,
        }),
      ]);

      await signalRun(
        new SmithersDb(db as any),
        first.runId,
        "new-data",
        { value: 3 },
      );
      expect(asyncPendingMetric("event")).toBe(metricBefore);

      const resumed = await runWorkflow(workflow, {
        input: {},
        runId: first.runId,
        resume: true,
      });

      expect(resumed.status).toBe("finished");
    } finally {
      cleanup();
    }
  });
});
