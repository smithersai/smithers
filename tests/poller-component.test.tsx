/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Poller, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

const COMPONENT_TIMEOUT_MS = 30_000;

function workflowTest(name: string, fn: () => Promise<unknown>) {
  test(name, fn, COMPONENT_TIMEOUT_MS);
}

describe("Poller", () => {
  workflowTest("happy path polls until the condition is satisfied", async () => {
    const {
      Workflow,
      Task,
      Sequence,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      check: z.object({
        satisfied: z.boolean(),
        status: z.string(),
        observedAtAttempt: z.number(),
      }),
      summary: z.object({
        attempts: z.number(),
        satisfied: z.boolean(),
        status: z.string(),
      }),
    });

    let calls = 0;

    const workflow = smithers((ctx) => {
      const checks = ctx.outputs("check");
      const latest = ctx.latest("check", "deploy-check");

      return (
        <Workflow name="poller-happy">
          <Sequence>
            <Poller
              id="deploy"
              check={() => {
                calls += 1;
                return {
                  satisfied: calls >= 3,
                  status: calls >= 3 ? "ready" : "pending",
                  observedAtAttempt: calls,
                };
              }}
              checkOutput={outputs.check}
              maxAttempts={5}
              intervalMs={1}
              onTimeout="return-last"
            />

            <Task id="summary" output={outputs.summary}>
              {{
                attempts: checks.length,
                satisfied: latest?.satisfied ?? false,
                status: latest?.status ?? "unknown",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(calls).toBe(3);

    const checkRows = (db as any)
      .select()
      .from(tables.check)
      .all()
      .sort((a: any, b: any) => a.iteration - b.iteration);
    const summaryRows = (db as any).select().from(tables.summary).all();

    expect(checkRows.map((row: any) => row.satisfied)).toEqual([false, false, true]);
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].attempts).toBe(3);
    expect(summaryRows[0].satisfied).toBe(true);
    expect(summaryRows[0].status).toBe("ready");
    cleanup();
  });

  workflowTest("condition met early exits after the first check", async () => {
    const {
      Workflow,
      Task,
      Sequence,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      check: z.object({
        satisfied: z.boolean(),
        status: z.string(),
        observedAtAttempt: z.number(),
      }),
      summary: z.object({
        attempts: z.number(),
        satisfied: z.boolean(),
        status: z.string(),
      }),
    });

    let calls = 0;

    const workflow = smithers((ctx) => {
      const checks = ctx.outputs("check");
      const latest = ctx.latest("check", "deploy-check");

      return (
        <Workflow name="poller-early">
          <Sequence>
            <Poller
              id="deploy"
              check={() => {
                calls += 1;
                return {
                  satisfied: true,
                  status: "ready",
                  observedAtAttempt: calls,
                };
              }}
              checkOutput={outputs.check}
              maxAttempts={5}
              intervalMs={1}
              onTimeout="return-last"
            />

            <Task id="summary" output={outputs.summary}>
              {{
                attempts: checks.length,
                satisfied: latest?.satisfied ?? false,
                status: latest?.status ?? "unknown",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(calls).toBe(1);

    const checkRows = (db as any).select().from(tables.check).all();
    const summaryRows = (db as any).select().from(tables.summary).all();

    expect(checkRows.length).toBe(1);
    expect(checkRows[0].satisfied).toBe(true);
    expect(summaryRows[0].attempts).toBe(1);
    cleanup();
  });

  workflowTest("transient check failure retries and still completes", async () => {
    const {
      Workflow,
      Task,
      Sequence,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      check: z.object({
        satisfied: z.boolean(),
        status: z.string(),
        observedAtAttempt: z.number(),
      }),
      summary: z.object({
        attempts: z.number(),
        satisfied: z.boolean(),
        status: z.string(),
      }),
    });

    let calls = 0;

    const workflow = smithers((ctx) => {
      const checks = ctx.outputs("check");
      const latest = ctx.latest("check", "deploy-check");

      return (
        <Workflow name="poller-retry">
          <Sequence>
            <Poller
              id="deploy"
              check={() => {
                calls += 1;
                if (calls === 1) {
                  throw new Error("transient network error");
                }
                return {
                  satisfied: calls >= 3,
                  status: calls >= 3 ? "ready" : "pending",
                  observedAtAttempt: calls,
                };
              }}
              checkOutput={outputs.check}
              maxAttempts={5}
              intervalMs={1}
              onTimeout="return-last"
            />

            <Task id="summary" output={outputs.summary}>
              {{
                attempts: checks.length,
                satisfied: latest?.satisfied ?? false,
                status: latest?.status ?? "unknown",
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(calls).toBe(3);

    const checkRows = (db as any)
      .select()
      .from(tables.check)
      .all()
      .sort((a: any, b: any) => a.iteration - b.iteration);
    const summaryRows = (db as any).select().from(tables.summary).all();

    expect(checkRows.length).toBe(2);
    expect(checkRows.map((row: any) => row.satisfied)).toEqual([false, true]);
    expect(summaryRows[0].attempts).toBe(2);
    expect(summaryRows[0].satisfied).toBe(true);
    cleanup();
  });
});
