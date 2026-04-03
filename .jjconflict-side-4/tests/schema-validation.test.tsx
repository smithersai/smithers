/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

describe("schema validation", () => {
  test("static payload with wrong type fails validation", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ count: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="bad-type">
        <Task id="t" output={outputs.out}>
          {{ count: "not-a-number" }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("failed");
    cleanup();
  });

  test("static payload with missing required field fails", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ name: z.string(), age: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="missing-field">
        <Task id="t" output={outputs.out}>
          {{ name: "test" }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("failed");
    cleanup();
  });

  test("compute callback with valid schema succeeds", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ name: z.string(), score: z.number() }),
    });

    const workflow = smithers(() => (
      <Workflow name="valid-compute">
        <Task id="t" output={outputs.out}>
          {() => ({ name: "test", score: 95 })}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].name).toBe("test");
    expect(rows[0].score).toBe(95);
    cleanup();
  });

  test("agent schema retry parses text on second attempt", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ val: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-retry",
      tools: {},
      generate: async () => {
        calls++;
        if (calls === 1) return { text: "not json at all" };
        return { text: '{"val": 42}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-retry">
        <Task id="t" output={outputs.out} agent={agent}>
          Return val.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(calls).toBe(2);
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].val).toBe(42);
    cleanup();
  });

  test("schema with optional fields succeeds when fields omitted", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
    });

    const workflow = smithers(() => (
      <Workflow name="optional-fields">
        <Task id="t" output={outputs.out}>
          {{ required: "yes" }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].required).toBe("yes");
    cleanup();
  });

  test("schema with array field stores as JSON", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ tags: z.array(z.string()) }),
    });

    const workflow = smithers(() => (
      <Workflow name="array-field">
        <Task id="t" output={outputs.out}>
          {{ tags: ["a", "b", "c"] }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].tags).toEqual(["a", "b", "c"]);
    cleanup();
  });

  test("schema with nested object stores as JSON", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ meta: z.object({ key: z.string(), val: z.number() }) }),
    });

    const workflow = smithers(() => (
      <Workflow name="nested-obj">
        <Task id="t" output={outputs.out}>
          {{ meta: { key: "x", val: 42 } }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].meta).toEqual({ key: "x", val: 42 });
    cleanup();
  });

  test("boolean fields stored and retrieved correctly", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ active: z.boolean() }),
    });

    const workflow = smithers(() => (
      <Workflow name="bool-field">
        <Task id="t" output={outputs.out}>
          {{ active: true }}
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].active).toBeTruthy();
    cleanup();
  });

  test("schema retry gets up to 3 attempts before hard failure", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ name: z.string(), count: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-retry-3",
      tools: {},
      generate: async () => {
        calls++;
        // First call: returns valid JSON but wrong schema (count is string)
        // All schema retries: also return wrong schema
        return { text: '{"name": "test", "count": "not-a-number"}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-retry-3-attempts">
        <Task id="t" output={outputs.out} agent={agent} retries={0}>
          Return name and count.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    // The initial generate call (1) + 3 schema fix attempts = 4 total
    expect(calls).toBe(4);
    expect(r.status).toBe("failed");
    cleanup();
  });

  test("schema retry succeeds on third attempt", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ name: z.string(), count: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-retry-third",
      tools: {},
      generate: async () => {
        calls++;
        if (calls <= 3) {
          // First call + 2 schema retries: wrong schema
          return { text: '{"name": "test", "count": "bad"}' };
        }
        // Third schema retry: correct
        return { text: '{"name": "test", "count": 42}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-retry-third-attempt">
        <Task id="t" output={outputs.out} agent={agent}>
          Return name and count.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    // 1 initial + 3 schema retries (3rd succeeds) = 4 total
    expect(calls).toBe(4);
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].name).toBe("test");
    expect(rows[0].count).toBe(42);
    cleanup();
  });

  test("schema retry does NOT burn a normal retry", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ val: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-no-burn",
      tools: {},
      generate: async () => {
        calls++;
        // On the first attempt: initial call returns bad schema, 3 schema
        // retries all fail too.  This should burn ONE normal retry.
        // On the second attempt (retry): return correct output immediately.
        if (calls <= 4) {
          return { text: '{"val": "not-a-number"}' };
        }
        return { text: '{"val": 99}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-no-burn-retry">
        <Task id="t" output={outputs.out} agent={agent} retries={1}>
          Return val.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    // First attempt: 1 initial + 3 schema retries = 4 calls (all fail)
    // Second attempt (retry): 1 call succeeds = 5 total
    expect(calls).toBe(5);
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].val).toBe(99);
    cleanup();
  });

  test("schema retry passes conversation messages to the agent", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ val: z.number() }),
    });

    let calls = 0;
    const receivedArgs: any[] = [];
    const agent: any = {
      id: "schema-messages",
      tools: {},
      generate: async (args: any) => {
        calls++;
        receivedArgs.push({ ...args });
        if (calls === 1) {
          // Return valid JSON but wrong type to trigger schema retry
          return {
            text: '{"val": "wrong"}',
            response: {
              messages: [
                { role: "assistant", content: [{ type: "text", text: '{"val": "wrong"}' }] },
              ],
            },
          };
        }
        // Schema retry: return correct
        return { text: '{"val": 42}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-messages">
        <Task id="t" output={outputs.out} agent={agent}>
          Return val.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(calls).toBe(2);
    // The second call (schema retry) should receive messages, not just a prompt
    const retryArgs = receivedArgs[1];
    expect(retryArgs.messages).toBeDefined();
    expect(Array.isArray(retryArgs.messages)).toBe(true);
    // Messages should include the original prompt + assistant response + correction
    expect(retryArgs.messages.length).toBeGreaterThanOrEqual(3);
    // The last message should be the schema fix request
    const lastMsg = retryArgs.messages[retryArgs.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("Validation errors");
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].val).toBe(42);
    cleanup();
  });

  test("schema retry extracts JSON from code fence on retry", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({ val: z.number() }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-fence",
      tools: {},
      generate: async () => {
        calls++;
        if (calls === 1) {
          return { text: '{"val": "wrong"}' };
        }
        // Return correct JSON inside a code fence
        return { text: 'Here is the fixed output:\n```json\n{"val": 7}\n```' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-fence">
        <Task id="t" output={outputs.out} agent={agent}>
          Return val.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(calls).toBe(2);
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].val).toBe(7);
    cleanup();
  });

  test("schema retry works with outputSchema (stricter zod)", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      out: z.object({
        status: z.enum(["active", "inactive"]),
        score: z.number().min(0).max(100),
      }),
    });

    let calls = 0;
    const agent: any = {
      id: "schema-strict-zod",
      tools: {},
      generate: async () => {
        calls++;
        if (calls === 1) {
          // Passes basic structure but fails enum validation
          return { text: '{"status": "unknown", "score": 50}' };
        }
        // Fixed
        return { text: '{"status": "active", "score": 85}' };
      },
    };

    const workflow = smithers(() => (
      <Workflow name="schema-strict-zod">
        <Task id="t" output={outputs.out} agent={agent}>
          Return status and score.
        </Task>
      </Workflow>
    ));

    const r = await runWorkflow(workflow, { input: {} });
    expect(r.status).toBe("finished");
    expect(calls).toBe(2);
    const rows = (db as any).select().from(tables.out).all();
    expect(rows[0].status).toBe("active");
    expect(rows[0].score).toBe(85);
    cleanup();
  });
});
