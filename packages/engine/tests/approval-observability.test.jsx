/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
import { approveNode, denyNode } from "../src/approvals.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { renderPrometheusMetrics } from "@smithers-orchestrator/observability";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
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
describe("approval observability", () => {
    test("denyNode records denied approvals and approval wait duration", async () => {
        const beforeDenied = metricValue("smithers_approvals_denied");
        const beforeWaitCount = metricValue("smithers_approval_wait_duration_ms_count");
        const { smithers, outputs, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = smithers(() => (<Workflow name="approval-deny-observability">
          <Task id="gate" output={outputs.a} needsApproval>
            {{ v: 1 }}
          </Task>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(denyNode(adapter, first.runId, "gate", 0, "rejected", "tester"));
            expect(metricValue("smithers_approvals_denied")).toBe(beforeDenied + 1);
            expect(metricValue("smithers_approval_wait_duration_ms_count")).toBe(beforeWaitCount + 1);
        }
        finally {
            cleanup();
        }
    });
    test("approveNode records approval wait duration", async () => {
        const beforeWaitCount = metricValue("smithers_approval_wait_duration_ms_count");
        const { smithers, outputs, db, cleanup } = createTestSmithers(schemas);
        try {
            const workflow = smithers(() => (<Workflow name="approval-grant-observability">
          <Task id="gate" output={outputs.a} needsApproval>
            {{ v: 1 }}
          </Task>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(approveNode(adapter, first.runId, "gate", 0, "approved", "tester"));
            expect(metricValue("smithers_approval_wait_duration_ms_count")).toBe(beforeWaitCount + 1);
        }
        finally {
            cleanup();
        }
    });
});
