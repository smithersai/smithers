/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { Kanban, runWorkflow } from "../src/index";
import { createTestSmithers } from "./helpers";
import { z } from "zod";

const COMPONENT_TIMEOUT_MS = 30_000;

function workflowTest(name: string, fn: () => Promise<unknown>) {
  test(name, fn, COMPONENT_TIMEOUT_MS);
}

function itemIdFromPrompt(prompt: string) {
  const match = prompt.match(/item:(\w+)/);
  return match?.[1] ?? "unknown";
}

describe("Kanban", () => {
  workflowTest("happy path processes every item through all columns", async () => {
    const {
      Workflow,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      triage: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      work: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      review: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      board: z.object({
        done: z.array(z.string()),
        remaining: z.array(z.string()),
        totalReviewed: z.number(),
      }),
    });

    const tickets = [
      { id: "t1", title: "Fix button" },
      { id: "t2", title: "Add tooltip" },
    ];

    const triageAgent = {
      id: "triage-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => ({
        output: {
          itemId: itemIdFromPrompt(prompt),
          next: "work",
          note: "triaged",
        },
      }),
    };
    const workAgent = {
      id: "work-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => ({
        output: {
          itemId: itemIdFromPrompt(prompt),
          next: "review",
          note: "implemented",
        },
      }),
    };
    const reviewAgent = {
      id: "review-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => ({
        output: {
          itemId: itemIdFromPrompt(prompt),
          next: "done",
          note: "approved",
        },
      }),
    };

    const workflow = smithers((ctx) => {
      const reviewRows = ctx.outputs("review");
      const doneIds = new Set(
        reviewRows
          .filter((row) => row.next === "done")
          .map((row) => row.itemId),
      );
      const remaining = tickets.filter((ticket) => !doneIds.has(ticket.id));

      return (
        <Workflow name="kanban-happy">
          <Kanban
            id="board"
            columns={[
              {
                name: "triage",
                agent: triageAgent,
                output: outputs.triage,
                prompt: ({ item }) => `item:${(item as any).id} column:triage`,
              },
              {
                name: "work",
                agent: workAgent,
                output: outputs.work,
                prompt: ({ item }) => `item:${(item as any).id} column:work`,
              },
              {
                name: "review",
                agent: reviewAgent,
                output: outputs.review,
                prompt: ({ item }) => `item:${(item as any).id} column:review`,
              },
            ]}
            useTickets={() => remaining}
            until={remaining.length === 0}
            maxIterations={3}
            onComplete={outputs.board}
          >
            {{
              done: [...doneIds].sort(),
              remaining: remaining.map((ticket) => ticket.id).sort(),
              totalReviewed: reviewRows.length,
            }}
          </Kanban>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const triageRows = (db as any).select().from(tables.triage).all();
    const workRows = (db as any).select().from(tables.work).all();
    const reviewRows = (db as any).select().from(tables.review).all();
    const boardRows = (db as any).select().from(tables.board).all();

    expect(triageRows.length).toBe(2);
    expect(workRows.length).toBe(2);
    expect(reviewRows.length).toBe(2);
    expect(boardRows.length).toBe(1);
    expect([...boardRows[0].done].sort()).toEqual(["t1", "t2"]);
    expect(boardRows[0].remaining).toEqual([]);
    cleanup();
  });

  workflowTest("condition met early skips columns and still writes completion output", async () => {
    const {
      Workflow,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      triage: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      work: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      review: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      board: z.object({
        done: z.array(z.string()),
        remaining: z.array(z.string()),
        totalReviewed: z.number(),
      }),
    });

    const agent = {
      id: "unused-agent",
      tools: {},
      generate: async () => {
        throw new Error("should not run");
      },
    };

    const workflow = smithers(() => (
      <Workflow name="kanban-early">
        <Kanban
          id="board"
          columns={[
            { name: "triage", agent, output: outputs.triage },
            { name: "work", agent, output: outputs.work },
            { name: "review", agent, output: outputs.review },
          ]}
          useTickets={() => []}
          until
          maxIterations={3}
          onComplete={outputs.board}
        >
          {{
            done: [],
            remaining: [],
            totalReviewed: 0,
          }}
        </Kanban>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    const triageRows = (db as any).select().from(tables.triage).all();
    const workRows = (db as any).select().from(tables.work).all();
    const reviewRows = (db as any).select().from(tables.review).all();
    const boardRows = (db as any).select().from(tables.board).all();

    expect(triageRows.length).toBe(0);
    expect(workRows.length).toBe(0);
    expect(reviewRows.length).toBe(0);
    expect(boardRows.length).toBe(1);
    expect(boardRows[0].done).toEqual([]);
    cleanup();
  });

  workflowTest("transient worker failure retries and the board still completes", async () => {
    const {
      Workflow,
      smithers,
      outputs,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      triage: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      work: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      review: z.object({ itemId: z.string(), next: z.string(), note: z.string() }),
      board: z.object({
        done: z.array(z.string()),
        remaining: z.array(z.string()),
        totalReviewed: z.number(),
      }),
    });

    const tickets = [
      { id: "t1", title: "Fix button" },
      { id: "t2", title: "Add tooltip" },
    ];
    const workCalls: Record<string, number> = {};

    const triageAgent = {
      id: "triage-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => ({
        output: {
          itemId: itemIdFromPrompt(prompt),
          next: "work",
          note: "triaged",
        },
      }),
    };
    const workAgent = {
      id: "work-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => {
        const itemId = itemIdFromPrompt(prompt);
        workCalls[itemId] = (workCalls[itemId] ?? 0) + 1;
        if (itemId === "t1" && workCalls[itemId] === 1) {
          throw new Error("retry me");
        }
        return {
          output: {
            itemId,
            next: "review",
            note: "implemented",
          },
        };
      },
    };
    const reviewAgent = {
      id: "review-agent",
      tools: {},
      generate: async ({ prompt }: { prompt: string }) => ({
        output: {
          itemId: itemIdFromPrompt(prompt),
          next: "done",
          note: "approved",
        },
      }),
    };

    const workflow = smithers((ctx) => {
      const reviewRows = ctx.outputs("review");
      const doneIds = new Set(
        reviewRows
          .filter((row) => row.next === "done")
          .map((row) => row.itemId),
      );
      const remaining = tickets.filter((ticket) => !doneIds.has(ticket.id));

      return (
        <Workflow name="kanban-retry">
          <Kanban
            id="board"
            columns={[
              {
                name: "triage",
                agent: triageAgent,
                output: outputs.triage,
                prompt: ({ item }) => `item:${(item as any).id} column:triage`,
              },
              {
                name: "work",
                agent: workAgent,
                output: outputs.work,
                prompt: ({ item }) => `item:${(item as any).id} column:work`,
                task: { retries: 1 },
              },
              {
                name: "review",
                agent: reviewAgent,
                output: outputs.review,
                prompt: ({ item }) => `item:${(item as any).id} column:review`,
              },
            ]}
            useTickets={() => remaining}
            until={remaining.length === 0}
            maxIterations={3}
            onComplete={outputs.board}
          >
            {{
              done: [...doneIds].sort(),
              remaining: remaining.map((ticket) => ticket.id).sort(),
              totalReviewed: reviewRows.length,
            }}
          </Kanban>
        </Workflow>
      );
    });

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    expect(workCalls.t1).toBe(2);

    const workRows = (db as any).select().from(tables.work).all();
    const reviewRows = (db as any).select().from(tables.review).all();
    const boardRows = (db as any).select().from(tables.board).all();

    expect(workRows.length).toBe(2);
    expect(reviewRows.length).toBe(2);
    expect(boardRows.length).toBe(1);
    expect([...boardRows[0].done].sort()).toEqual(["t1", "t2"]);
    cleanup();
  });
});
