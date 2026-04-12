/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
describe("Concurrent runs", () => {
    test("starting a second run does not cancel the first run's in-progress attempt", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        let active = 0;
        const slowAgent = {
            id: "slow-agent",
            tools: {},
            generate: async () => {
                active += 1;
                await sleep(150);
                active -= 1;
                return { output: { value: 1 } };
            },
        };
        const workflow = smithers(() => (<Workflow name="concurrent-runs">
        <Task id="slow" output={outputs.outputA} agent={slowAgent}>
          run slow task
        </Task>
      </Workflow>));
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        const firstRunId = "run-a";
        const secondRunId = "run-b";
        const firstPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: firstRunId }));
        for (let i = 0; i < 40; i++) {
            const attempts = await adapter.listAttempts(firstRunId, "slow", 0);
            if (attempts.some((attempt) => attempt.state === "in-progress"))
                break;
            await sleep(10);
        }
        const secondPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: secondRunId }));
        await sleep(25);
        const firstAttemptsAfterSecondStart = await adapter.listAttempts(firstRunId, "slow", 0);
        expect(firstAttemptsAfterSecondStart[0]?.state).toBe("in-progress");
        const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
        expect(firstResult.status).toBe("finished");
        expect(secondResult.status).toBe("finished");
        expect(active).toBe(0);
        cleanup();
    });
});
