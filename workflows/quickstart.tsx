/** @jsxImportSource smithers */
import { smithers, Workflow, Task, Sequence } from "smithers";
import { Experimental_Agent as Agent, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { z } from "zod";

const input = sqliteTable("input", {
  runId: text("run_id").primaryKey(),
  goal: text("goal").notNull(),
});

const plan = sqliteTable(
  "plan",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    summary: text("summary").notNull(),
    steps: text("steps", { mode: "json" }).$type<string[]>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId] }),
  }),
);

const brief = sqliteTable(
  "brief",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    brief: text("brief").notNull(),
    stepCount: integer("step_count").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId] }),
  }),
);

export const schema = { input, plan, brief };
export const db = drizzle("./workflows/quickstart.db", { schema });

(db as any).$client.exec(`
  CREATE TABLE IF NOT EXISTS input (
    run_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plan (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    steps TEXT,
    PRIMARY KEY (run_id, node_id)
  );
  CREATE TABLE IF NOT EXISTS brief (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    step_count INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id)
  );
`);

const planSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()).min(3).max(8),
});

const briefSchema = z.object({
  brief: z.string(),
  stepCount: z.number().int().min(1),
});

const planAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  output: Output.object({ schema: planSchema }),
  instructions:
    "You are a planning assistant. Return a concise summary and 3-8 actionable steps.",
});

const briefAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  output: Output.object({ schema: briefSchema }),
  instructions:
    "You are a concise technical writer. Produce a 5-8 sentence brief.",
});

export default smithers(db, (ctx) => (
  <Workflow name="quickstart">
    <Sequence>
      <Task id="plan" output={schema.plan} agent={planAgent}>
        {`Create a short plan for this goal:\n${ctx.input.goal}`}
      </Task>
      <Task id="brief" output={schema.brief} agent={briefAgent}>
        {`Goal: ${ctx.input.goal}
Plan summary: ${ctx.output(schema.plan, { nodeId: "plan" }).summary}
Steps: ${JSON.stringify(ctx.output(schema.plan, { nodeId: "plan" }).steps)}

Write a brief based on the plan. The "stepCount" must equal the number of steps.`}
      </Task>
    </Sequence>
  </Workflow>
));
