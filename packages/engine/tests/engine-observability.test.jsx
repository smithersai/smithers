/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { renderPrometheusMetrics } from "@smithers/observability";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const schemas = {
    a: z.object({ v: z.number() }),
};
/**
 * @param {string} name
 * @returns {number}
 */
function metricValue(name) {
    const prefix = `${name} `;
    const line = renderPrometheusMetrics()
        .split("\n")
        .find((entry) => entry.startsWith(prefix));
    if (!line)
        return 0;
    return Number(line.slice(prefix.length));
}
/**
 * @param {any} response
 * @param {number} delayMs
 */
function fakeAgent(response, delayMs) {
    return {
        id: "slow-agent",
        tools: {},
        generate: async () => {
            await sleep(delayMs);
            return { output: response };
        },
    };
}
describe("engine observability", () => {
    test("records scheduler wait duration while tasks are in flight", async () => {
        const before = metricValue("smithers_scheduler_wait_duration_ms_count");
        const { smithers, outputs, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = smithers(() => (<Workflow name="scheduler-wait-observability">
          <Task id="slow" output={outputs.a} agent={fakeAgent({ v: 1 }, 30)}>
            compute
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            expect(metricValue("smithers_scheduler_wait_duration_ms_count")).toBeGreaterThan(before);
        }
        finally {
            cleanup();
        }
    });
});
