/** @jsxImportSource smithers */
import { smithers, Workflow, Task } from "smithers";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

const input = sqliteTable("input", {
  runId: text("run_id").primaryKey(),
  name: text("name").notNull(),
});

const output = sqliteTable(
  "output",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    message: text("message").notNull(),
    length: integer("length").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId] }),
  }),
);

export const schema = { input, output };
export const db = drizzle("./workflows/hello.db", { schema });

(db as any).$client.exec(`
  CREATE TABLE IF NOT EXISTS input (
    run_id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS output (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    message TEXT NOT NULL,
    length INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id)
  );
`);

export default smithers(db, (ctx) => (
  <Workflow name="hello">
    <Task id="hello" output={output}>
      {{
        message: `Hello, ${ctx.input.name}!`,
        length: ctx.input.name.length,
      }}
    </Task>
  </Workflow>
));
