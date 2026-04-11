import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type {
  SmithersAlertPolicy,
  SmithersAlertPolicyDefaults,
  SmithersAlertPolicyRule,
  SmithersWorkflowOptions,
} from "@smithers/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { createSmithersContext, SmithersContext as GlobalSmithersContext } from "@smithers/react-reconciler/context";
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
  ContinueAsNew as BaseContinueAsNew,
  continueAsNew as baseContinueAsNew,
  Worktree as BaseWorktree,
  Sandbox as BaseSandbox,
  Signal as BaseSignal,
  Timer as BaseTimer,
} from "@smithers/components";
import type {
  ApprovalProps,
  SandboxProps,
  SignalProps,
  WorkflowProps,
  TaskProps,
  DepsSpec,
  TimerProps,
} from "@smithers/components";

import { zodToTable } from "@smithers/db/zodToTable";
import { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
import { resolve } from "node:path";
import type { z } from "zod";
import { SmithersError } from "@smithers/errors/SmithersError";

type HotCacheEntry = {
  api: CreateSmithersApi<any>;
  schemaSig: string;
  setModuleAlertPolicy: (alertPolicy?: SmithersAlertPolicy) => void;
};
const hotCache = new Map<string, HotCacheEntry>();

type CreateSmithersOptions = {
  alertPolicy?: SmithersAlertPolicy;
  dbPath?: string;
  journalMode?: string;
};

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

function mergeAlertLabels(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
  };
}

function mergeAlertDefaults(
  base?: SmithersAlertPolicyDefaults,
  override?: SmithersAlertPolicyDefaults,
): SmithersAlertPolicyDefaults | undefined {
  if (!base && !override) return undefined;

  const merged: SmithersAlertPolicyDefaults = {
    ...base,
    ...override,
  };
  const labels = mergeAlertLabels(base?.labels, override?.labels);
  if (labels) merged.labels = labels;
  return merged;
}

function mergeAlertRule(
  base?: SmithersAlertPolicyRule,
  override?: SmithersAlertPolicyRule,
): SmithersAlertPolicyRule | undefined {
  if (!base && !override) return undefined;

  const merged: SmithersAlertPolicyRule = {
    ...base,
    ...override,
  };
  const labels = mergeAlertLabels(base?.labels, override?.labels);
  if (labels) merged.labels = labels;
  return merged;
}

function mergeAlertRules(
  base?: Record<string, SmithersAlertPolicyRule>,
  override?: Record<string, SmithersAlertPolicyRule>,
): Record<string, SmithersAlertPolicyRule> | undefined {
  if (!base && !override) return undefined;

  const merged: Record<string, SmithersAlertPolicyRule> = {
    ...base,
  };
  for (const [name, rule] of Object.entries(override ?? {})) {
    merged[name] = mergeAlertRule(base?.[name], rule) ?? rule;
  }
  return merged;
}

function mergeAlertPolicies(
  base?: SmithersAlertPolicy,
  override?: SmithersAlertPolicy,
): SmithersAlertPolicy | undefined {
  if (!base && !override) return undefined;

  const merged: SmithersAlertPolicy = {};
  const defaults = mergeAlertDefaults(base?.defaults, override?.defaults);
  const rules = mergeAlertRules(base?.rules, override?.rules);
  const reactions =
    base?.reactions || override?.reactions
      ? {
          ...base?.reactions,
          ...override?.reactions,
        }
      : undefined;

  if (defaults) merged.defaults = defaults;
  if (rules) merged.rules = rules;
  if (reactions) merged.reactions = reactions;
  return merged;
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
  ContinueAsNew: typeof BaseContinueAsNew;
  continueAsNew: typeof baseContinueAsNew;
  Worktree: typeof BaseWorktree;
  Sandbox: (props: SandboxProps) => React.ReactElement;
  Signal: <Schema extends z.ZodObject<any>>(
    props: SignalProps<Schema>,
  ) => React.ReactElement;
  Timer: typeof BaseTimer;
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
  opts?: CreateSmithersOptions,
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
      cached.setModuleAlertPolicy(opts?.alertPolicy);
      return cached.api as any;
    }
    // Will cache after creating the API below
  }

  // 1. Generate Drizzle tables from Zod schemas
  const tables: Record<string, any> = {};
  const inputTable = schemas.input
    ? zodToTable("input", schemas.input, { isInput: true })
    : sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
      });

  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
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
  if (schemas.input) {
    const inputDdl = zodToCreateTableSQL("input", schemas.input, { isInput: true });
    sqlite.run(inputDdl);
  } else {
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
  }

  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
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
  let moduleAlertPolicy = opts?.alertPolicy;

  function Workflow(props: WorkflowProps) {
    return React.createElement(BaseWorkflow, props, props.children);
  }

  function Approval<Row>(props: ApprovalProps<Row>) {
    return React.createElement(BaseApproval, {
      ...props,
      smithersContext: RuntimeSmithersContext,
    } as any);
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

  function Sandbox(props: SandboxProps) {
    const workflow =
      props.workflow ??
      ({
        db,
        build: () =>
          React.createElement(
            BaseWorkflow,
            { name: `sandbox:${props.id}` },
            props.children as any,
          ),
        opts: {},
        schemaRegistry,
        zodToKeyName,
      } as any);
    return React.createElement(BaseSandbox, {
      ...props,
      workflow,
      smithersContext: RuntimeSmithersContext,
    } as any);
  }

  function Signal<SignalSchema extends z.ZodObject<any>>(
    props: SignalProps<SignalSchema>,
  ) {
    return React.createElement(BaseSignal, {
      ...props,
      smithersContext: RuntimeSmithersContext,
    } as any);
  }

  function boundSmithers(
    build: (ctx: SmithersCtx<Schemas>) => React.ReactElement,
    smithersOpts?: SmithersWorkflowOptions,
  ): SmithersWorkflow<Schemas> {
    const workflowOpts: SmithersWorkflowOptions = {
      ...smithersOpts,
    };
    const alertPolicy = mergeAlertPolicies(
      moduleAlertPolicy,
      smithersOpts?.alertPolicy,
    );
    if (alertPolicy) workflowOpts.alertPolicy = alertPolicy;

    return {
      db,
      build: (ctx: SmithersCtx<Schemas>) => {
        ctxRef.current = ctx;
        return React.createElement(
          RuntimeSmithersContext.Provider,
          { value: ctxRef.current },
          React.createElement(
            GlobalSmithersContext.Provider,
            { value: ctxRef.current },
            build(ctx),
          ),
        );
      },
      opts: workflowOpts,
      schemaRegistry,
      zodToKeyName,
    } as SmithersWorkflow<Schemas>;
  }

  const setModuleAlertPolicy = (alertPolicy?: SmithersAlertPolicy) => {
    moduleAlertPolicy = alertPolicy;
  };

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
    ContinueAsNew: BaseContinueAsNew,
    continueAsNew: baseContinueAsNew,
    Worktree: BaseWorktree,
    Sandbox,
    Signal,
    Timer: BaseTimer,
    useCtx,
    smithers: boundSmithers,
    db,
    tables: tables as any,
    outputs: schemas as any,
  };

  if (process.env.SMITHERS_HOT === "1") {
    const sig = computeSchemaSig(schemas as Record<string, any>, absDbPath);
    hotCache.set(absDbPath, {
      api: api as any,
      schemaSig: sig,
      setModuleAlertPolicy,
    });
  }

  return api;
}
