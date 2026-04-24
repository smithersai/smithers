/** @jsxImportSource smithers-orchestrator */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { z } from "zod";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

test("duplicate output schemas route correctly through createSmithers outputs", async () => {
    const shared = z.object({ value: z.string() });
    const api = createTestSmithers({
        accessibility: shared,
        product: shared,
    });
    expect(api.outputs.accessibility).not.toBe(shared);
    expect(api.outputs.product).not.toBe(shared);
    expect(api.outputs.accessibility).not.toBe(api.outputs.product);
    const workflow = api.smithers(() => (<Workflow name="duplicate-output-schemas">
      <Task id="accessibility" output={api.outputs.accessibility}>
        {{ value: "a11y" }}
      </Task>
      <Task id="product" output={api.outputs.product}>
        {{ value: "product" }}
      </Task>
    </Workflow>));
    const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "duplicate-output-schemas",
    }));
    expect(result.status).toBe("finished");
    expect(api.db.select().from(api.tables.accessibility).all()).toEqual([
        expect.objectContaining({
            nodeId: "accessibility",
            value: "a11y",
        }),
    ]);
    expect(api.db.select().from(api.tables.product).all()).toEqual([
        expect.objectContaining({
            nodeId: "product",
            value: "product",
        }),
    ]);
    api.cleanup?.();
});

test("duplicate raw schema refs fail with a helpful error", async () => {
    const shared = z.object({ value: z.string() });
    const api = createTestSmithers({
        accessibility: shared,
        product: shared,
    });
    const workflow = api.smithers(() => (<Workflow name="duplicate-output-schema-error">
      <Task id="accessibility" output={shared}>
        {{ value: "a11y" }}
      </Task>
    </Workflow>));
    const result = await Effect.runPromise(runWorkflow(workflow, {
        input: {},
        runId: "duplicate-output-schema-error",
    }));
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("outputs.<key>");
    expect(api.db.select().from(api.tables.product).all()).toHaveLength(0);
    api.cleanup?.();
});
