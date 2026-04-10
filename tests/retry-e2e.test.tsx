/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/db/adapter";
import { Task, Workflow, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { outputSchemas } from "./schema";

const RETRY_E2E_TIMEOUT_MS = 15_000;

describe("retry policy e2e", () => {
  test("task retries on failure up to max retries", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db as any);

    try {
      let callCount = 0;
      const agent: any = {
        id: "retry-success-agent",
        tools: {},
        async generate() {
          callCount += 1;
          if (callCount < 3) {
            throw new Error(`fail ${callCount}`);
          }
          return { output: { value: callCount } };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="retry-e2e-success">
          <Task id="flaky" output={outputs.outputA} agent={agent} retries={3}>
            Retry until success.
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });

      expect(result.status).toBe("finished");
      expect(callCount).toBe(3);

      const attempts = await adapter.listAttempts(result.runId, "flaky", 0);
      expect(attempts).toHaveLength(3);
    } finally {
      cleanup();
    }
  }, RETRY_E2E_TIMEOUT_MS);

  test("task fails after exhausting all retries", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db as any);

    try {
      let callCount = 0;
      const agent: any = {
        id: "retry-fail-agent",
        tools: {},
        async generate() {
          callCount += 1;
          throw new Error(`always fails ${callCount}`);
        },
      };

      const workflow = smithers(() => (
        <Workflow name="retry-e2e-fail">
          <Task id="doomed" output={outputs.outputA} agent={agent} retries={2}>
            Keep trying.
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });

      expect(result.status).toBe("failed");
      expect(callCount).toBe(3);

      const attempts = await adapter.listAttempts(result.runId, "doomed", 0);
      expect(attempts).toHaveLength(3);
    } finally {
      cleanup();
    }
  }, RETRY_E2E_TIMEOUT_MS);

  test("continueOnFail allows workflow to proceed past failed task", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db as any);

    try {
      let secondTaskCalls = 0;
      const failingAgent: any = {
        id: "continue-on-fail-first",
        tools: {},
        async generate() {
          throw new Error("first task failed");
        },
      };
      const succeedingAgent: any = {
        id: "continue-on-fail-second",
        tools: {},
        async generate() {
          secondTaskCalls += 1;
          return { output: { value: 2 } };
        },
      };

      const workflow = smithers(() => (
        <Workflow name="retry-e2e-continue-on-fail">
          <Task
            id="first"
            output={outputs.outputA}
            agent={failingAgent}
            retries={0}
            continueOnFail
          >
            Fail first.
          </Task>
          <Task
            id="second"
            output={outputs.outputB}
            agent={succeedingAgent}
            dependsOn={["first"]}
          >
            Continue after the failed task.
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });

      expect(result.status).toBe("finished");
      expect(secondTaskCalls).toBe(1);

      const nodes = await adapter.listNodes(result.runId);
      const firstNode = nodes.find((node: any) => node.nodeId === "first" && node.iteration === 0);
      const secondNode = nodes.find((node: any) => node.nodeId === "second" && node.iteration === 0);

      expect(firstNode?.state).toBe("failed");
      expect(secondNode?.state).toBe("finished");
    } finally {
      cleanup();
    }
  });

  test("exponential backoff increases delay between retries", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db as any);

    try {
      const callTimes: number[] = [];
      let callCount = 0;
      const agent: any = {
        id: "retry-backoff-agent",
        tools: {},
        async generate() {
          callCount += 1;
          callTimes.push(performance.now());
          throw new Error(`backoff failure ${callCount}`);
        },
      };

      const workflow = smithers(() => (
        <Workflow name="retry-e2e-exponential-backoff">
          <Task
            id="backoff"
            output={outputs.outputA}
            agent={agent}
            retries={3}
            retryPolicy={{ backoff: "exponential", initialDelayMs: 50 }}
          >
            Measure retry delays.
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });

      expect(result.status).toBe("failed");
      expect(callCount).toBe(4);
      expect(callTimes).toHaveLength(4);

      const attempts = await adapter.listAttempts(result.runId, "backoff", 0);
      expect(attempts).toHaveLength(4);

      const delays = callTimes.slice(1).map((time, index) => time - callTimes[index]!);
      expect(delays).toHaveLength(3);
      expect(delays[0]!).toBeGreaterThanOrEqual(40);
      expect(delays[1]!).toBeGreaterThanOrEqual(90);
      expect(delays[2]!).toBeGreaterThanOrEqual(190);
      expect(delays[1]!).toBeGreaterThan(delays[0]!);
      expect(delays[2]!).toBeGreaterThan(delays[1]!);
    } finally {
      cleanup();
    }
  }, RETRY_E2E_TIMEOUT_MS);
});
