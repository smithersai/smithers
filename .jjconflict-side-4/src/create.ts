import type { SmithersWorkflow } from "./SmithersWorkflow";
import type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "./SchemaRegistryEntry";
import type { SmithersCtx } from "./SmithersCtx";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { createSmithersContext } from "./context";
import {
  Approval as BaseApproval,
  Workflow as BaseWorkflow,
  Task as BaseTask,
  Sequence as BaseSequence,
  Parallel as BaseParallel,
  MergeQueue as BaseMergeQueue,
  Branch as BaseBranch,
  Loop as BaseLoop,
  Ralph as BaseRalph,
  Worktree as BaseWorktree,
} from "./components";
import type { ApprovalProps, WorkflowProps, TaskProps, DepsSpec } from "./components";

import { zodToTable } from "./zodToTable";
import { zodToCreateTableSQL } from "./zodToCreateTableSQL";
import { camelToSnake } from "./utils/camelToSnake";
import { resolve } from "node:path";
import type { z } from "zod";
import { SmithersError } from "./utils/errors";

type HotCacheEntry = {
  api: CreateSmithersApi<any>;
  schemaSig: string;
};
const hotCache = new Map<string, HotCacheEntry>();

function computeSchemaSig(
  schemas: Record<string, any>,
  dbPath: string,
): string {
  const parts: string[] = [dbPath];
  for (const name of Object.keys(schemas).sort()) {
    const tableName = camelToSnake(name);
    const ddl = zodToCreateTableSQL(tableName, schemas[name]);
    parts.push(`${name}:${ddl}`);
  }
  return parts.join("\n");
}

/** Union of all Zod schema values registered in the schema, constrained to ZodObject. */
type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<any>>;

export type CreateSmithersApi<Schema = any> = {
  Workflow: (props: WorkflowProps) => React.ReactElement;
  Approval: <Row>(props: ApprovalProps<Row, SchemaOutput<Schema>>) => React.ReactElement;
  Task: <Row, D extends DepsSpec = {}>(
    props: TaskProps<Row, SchemaOutput<Schema>, D>,
  ) => React.ReactElement;
  Sequence: typeof BaseSequence;
  Parallel: typeof BaseParallel;
  MergeQueue: typeof BaseMergeQueue;
  Branch: typeof BaseBranch;
  Loop: typeof BaseLoop;
  Ralph: typeof BaseRalph;
  Worktree: typeof BaseWorktree;
  useCtx: () => SmithersCtx<Schema>;
  smithers: (
    build: (ctx: SmithersCtx<Schema>) => React.ReactElement,
    opts?: SmithersWorkflowOptions,
  ) => SmithersWorkflow<Schema>;
  db: BunSQLiteDatabase<any>;
  tables: { [K in keyof Schema]: any };
  outputs: { [K in keyof Schema]: Schema[K] };
};

/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @example
 * ```ts
 * const { Workflow, Task, smithers, outputs } = createSmithers({
 *   discover: discoverOutputSchema,
 *   research: researchOutputSchema,
 * });
 *
 * export default smithers((ctx) => (
 *   <Workflow name="my-workflow">
 *     <Task id="discover" output={outputs.discover} agent={myAgent}>...</Task>
 *   </Workflow>
 * ));
 * ```
 */
export function createSmithers<
  Schemas extends Record<string, z.ZodObject<any>>,
>(
  schemas: Schemas,
  opts?: { dbPath?: string; journalMode?: string },
): CreateSmithersApi<Schemas> {
  const dbPath = opts?.dbPath ?? "./smithers.db";
  const absDbPath = resolve(process.cwd(), dbPath);

  if (process.env.SMITHERS_HOT === "1") {
    const sig = computeSchemaSig(schemas as Record<string, any>, absDbPath);
    const cached = hotCache.get(absDbPath);
    if (cached) {
      if (cached.schemaSig !== sig) {
        throw new SmithersError(
          "SCHEMA_CHANGE_HOT",
          "[smithers hot] Schema change detected; restart required to apply schema changes.",
        );
      }
      return cached.api as any;
    }
    // Will cache after creating the API below
  }

  // 1. Generate Drizzle tables from Zod schemas
  const tables: Record<string, any> = {};
  const inputTable = sqliteTable("input", {
    runId: text("run_id").primaryKey(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  });

  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue; // reserved for typing ctx.input
    const tableName = camelToSnake(name);
    tables[name] = zodToTable(tableName, zodSchema);
  }

  // 2. Create SQLite db
  const sqlite = new Database(dbPath);
  sqlite.run(`PRAGMA journal_mode = ${opts?.journalMode ?? "WAL"}`);
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA foreign_keys = ON");

  // Register a process-exit hook to explicitly close the Database.
  // bun:sqlite's GC finalizer calls sqlite3_close() which fatally aborts if
  // Drizzle's cached prepared statements haven't been finalized first.
  // Calling close() ourselves lets sqlite3 finalize everything gracefully.
  let dbClosed = false;
  const closeDb = () => {
    if (dbClosed) return;
    dbClosed = true;
    try { sqlite.close(); } catch {}
  };
  process.on("exit", closeDb);

  // 3. Auto-create tables using CREATE TABLE IF NOT EXISTS
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`,
  );
  try {
    const cols = sqlite.query(`PRAGMA table_info("input")`).all() as Array<{
      name?: string;
    }>;
    const hasPayload = cols.some((col) => col?.name === "payload");
    if (!hasPayload) {
      sqlite.run(`ALTER TABLE "input" ADD COLUMN payload TEXT`);
    }
  } catch {
    // ignore - older SQLite or permission issues; input payload remains best-effort
  }

  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue; // reserved for typing ctx.input
    const tableName = camelToSnake(name);
    const ddl = zodToCreateTableSQL(tableName, zodSchema);
    sqlite.run(ddl);
  }

  // 4. Create Drizzle instance with all tables in the schema
  const drizzleSchema: Record<string, any> = { input: inputTable };
  for (const [key, table] of Object.entries(tables)) {
    drizzleSchema[key] = table;
  }
  const db = drizzle(sqlite, { schema: drizzleSchema });

  // 5. Build schema registry for engine resolution of string output keys
  const schemaRegistry = new Map<string, SchemaRegistryEntry>();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    schemaRegistry.set(name, { table: tables[name], zodSchema });
  }

  // 6. Build reverse lookup: ZodObject reference → schema key name
  const zodToKeyName = new Map<z.ZodObject<any>, string>();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    zodToKeyName.set(zodSchema, name);
  }

  // 7. Context + hooks
  const {
    SmithersContext: RuntimeSmithersContext,
    useCtx,
  } = createSmithersContext<Schemas>();
  const ctxRef = { current: null as SmithersCtx<Schemas> | null };

  function Workflow(props: WorkflowProps) {
    return React.createElement(BaseWorkflow, props, props.children);
  }

  function Approval<Row>(props: ApprovalProps<Row>) {
    return React.createElement(BaseApproval, props as any);
  }

  /**
   * Task wrapper that resolves ZodObject output references against the
   * schema registry by reference equality, injecting the outputSchema.
   */
  function Task<Row, D extends DepsSpec = {}>(
    props: TaskProps<Row, SchemaOutput<Schemas>, D>,
  ) {
    return React.createElement(BaseTask, {
      ...props,
      smithersContext: RuntimeSmithersContext,
    } as any);
  }

  function boundSmithers(
    build: (ctx: SmithersCtx<Schemas>) => React.ReactElement,
    smithersOpts?: SmithersWorkflowOptions,
  ): SmithersWorkflow<Schemas> {
    return {
      db,
      build: (ctx: SmithersCtx<Schemas>) => {
        ctxRef.current = ctx;
        return React.createElement(
          RuntimeSmithersContext.Provider,
          { value: ctxRef.current },
          build(ctx),
        );
      },
      opts: smithersOpts ?? {},
      schemaRegistry,
      zodToKeyName,
    } as SmithersWorkflow<Schemas>;
  }

  const api = {
    Workflow,
    Approval,
    Task,
    Sequence: BaseSequence,
    Parallel: BaseParallel,
    MergeQueue: BaseMergeQueue,
    Branch: BaseBranch,
    Loop: BaseLoop,
    Ralph: BaseRalph,
    Worktree: BaseWorktree,
    useCtx,
    smithers: boundSmithers,
    db,
    tables: tables as any,
    outputs: schemas as any,
  };

  if (process.env.SMITHERS_HOT === "1") {
    const sig = computeSchemaSig(schemas as Record<string, any>, absDbPath);
    hotCache.set(absDbPath, { api: api as any, schemaSig: sig });
  }

  return api;
}
