/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "../src/index";
import { renderPrometheusMetrics } from "../src/observability";
import { createTestSmithers, sleep } from "./helpers";
import { z } from "zod";

const schemas = {
  a: z.object({ v: z.number() }),
};

function metricValue(name: string): number {
  const prefix = `${name} `;
  const line = renderPrometheusMetrics()
    .split("\n")
    .find((entry) => entry.startsWith(prefix));
  if (!line) return 0;
  return Number(line.slice(prefix.length));
}

function fakeAgent(response: any, delayMs: number) {
  return {
    id: "slow-agent",
    tools: {},
    generate: async () => {
      await sleep(delayMs);
      return { output: response };
    },
  } as any;
}

describe("engine observability", () => {
  test("records scheduler wait duration while tasks are in flight", async () => {
    const before = metricValue("smithers_scheduler_wait_duration_ms_count");
    const { smithers, outputs, cleanup } = createTestSmithers(schemas);

    try {
      const workflow = smithers(() => (
        <Workflow name="scheduler-wait-observability">
          <Task
            id="slow"
            output={outputs.a}
            agent={fakeAgent({ v: 1 }, 30)}
          >
            compute
          </Task>
        </Workflow>
      ));

      const result = await runWorkflow(workflow, { input: {} });
      expect(result.status).toBe("finished");
      expect(metricValue("smithers_scheduler_wait_duration_ms_count")).toBeGreaterThan(before);
    } finally {
      cleanup();
    }
  });
});
