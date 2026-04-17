// @smithers-type-exports-begin
/**
 * @template Schema
 * @typedef {import("./CreateSmithersApi.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
// @smithers-type-exports-end

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { createSmithersContext, SmithersContext as GlobalSmithersContext } from "@smithers/react-reconciler/context";
import { Approval as BaseApproval, Workflow as BaseWorkflow, Task as BaseTask, Sequence as BaseSequence, Parallel as BaseParallel, MergeQueue as BaseMergeQueue, Branch as BaseBranch, Loop as BaseLoop, Ralph as BaseRalph, ContinueAsNew as BaseContinueAsNew, continueAsNew as baseContinueAsNew, Worktree as BaseWorktree, Sandbox as BaseSandbox, Signal as BaseSignal, Timer as BaseTimer, } from "@smithers/components";
import { zodToTable } from "@smithers/db/zodToTable";
import { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
import { resolve } from "node:path";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("@smithers/components").ApprovalProps<any, any>} ApprovalProps */
/** @typedef {import("@smithers/components").SandboxProps} SandboxProps */
/** @typedef {import("@smithers/components").SignalProps<any>} SignalProps */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/**
 * @template Schema
 * @typedef {import("@smithers/driver/SmithersCtx").SmithersCtx<Schema>} SmithersCtx
 */
/**
 * @template Schema
 * @typedef {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("@smithers/components").WorkflowProps} WorkflowProps */
/** @typedef {import("./CreateSmithersOptions.ts").CreateSmithersOptions} CreateSmithersOptions */

const hotCache = new Map();
/**
 * @param {Record<string, any>} schemas
 * @param {string} dbPath
 * @returns {string}
 */
function computeSchemaSig(schemas, dbPath) {
    const parts = [dbPath];
    for (const name of Object.keys(schemas).sort()) {
        const tableName = camelToSnake(name);
        const ddl = zodToCreateTableSQL(tableName, schemas[name]);
        parts.push(`${name}:${ddl}`);
    }
    return parts.join("\n");
}
/**
 * @param {Record<string, string>} [base]
 * @param {Record<string, string>} [override]
 * @returns {Record<string, string> | undefined}
 */
function mergeAlertLabels(base, override) {
    if (!base && !override)
        return undefined;
    return {
        ...base,
        ...override,
    };
}
/**
 * @param {SmithersAlertPolicyDefaults} [base]
 * @param {SmithersAlertPolicyDefaults} [override]
 * @returns {SmithersAlertPolicyDefaults | undefined}
 */
function mergeAlertDefaults(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
        ...override,
    };
    const labels = mergeAlertLabels(base?.labels, override?.labels);
    if (labels)
        merged.labels = labels;
    return merged;
}
/**
 * @param {SmithersAlertPolicyRule} [base]
 * @param {SmithersAlertPolicyRule} [override]
 * @returns {SmithersAlertPolicyRule | undefined}
 */
function mergeAlertRule(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
        ...override,
    };
    const labels = mergeAlertLabels(base?.labels, override?.labels);
    if (labels)
        merged.labels = labels;
    return merged;
}
/**
 * @param {Record<string, SmithersAlertPolicyRule>} [base]
 * @param {Record<string, SmithersAlertPolicyRule>} [override]
 * @returns {Record<string, SmithersAlertPolicyRule> | undefined}
 */
function mergeAlertRules(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {
        ...base,
    };
    for (const [name, rule] of Object.entries(override ?? {})) {
        merged[name] = mergeAlertRule(base?.[name], rule) ?? rule;
    }
    return merged;
}
/**
 * @param {SmithersAlertPolicy} [base]
 * @param {SmithersAlertPolicy} [override]
 * @returns {SmithersAlertPolicy | undefined}
 */
function mergeAlertPolicies(base, override) {
    if (!base && !override)
        return undefined;
    const merged = {};
    const defaults = mergeAlertDefaults(base?.defaults, override?.defaults);
    const rules = mergeAlertRules(base?.rules, override?.rules);
    const reactions = base?.reactions || override?.reactions
        ? {
            ...base?.reactions,
            ...override?.reactions,
        }
        : undefined;
    if (defaults)
        merged.defaults = defaults;
    if (rules)
        merged.rules = rules;
    if (reactions)
        merged.reactions = reactions;
    return merged;
}
/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions} [opts]
 * @returns {import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas>}
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
export function createSmithers(schemas, opts) {
    const dbPath = opts?.dbPath ?? "./smithers.db";
    const absDbPath = resolve(process.cwd(), dbPath);
    if (process.env.SMITHERS_HOT === "1") {
        const sig = computeSchemaSig(schemas, absDbPath);
        const cached = hotCache.get(absDbPath);
        if (cached) {
            if (cached.schemaSig !== sig) {
                throw new SmithersError("SCHEMA_CHANGE_HOT", "[smithers hot] Schema change detected; restart required to apply schema changes.");
            }
            cached.setModuleAlertPolicy(opts?.alertPolicy);
            return cached.api;
        }
        // Will cache after creating the API below
    }
    // 1. Generate Drizzle tables from Zod schemas
    const tables = {};
    const inputTable = schemas.input
        ? zodToTable("input", schemas.input, { isInput: true })
        : sqliteTable("input", {
            runId: text("run_id").primaryKey(),
            payload: text("payload", { mode: "json" }).$type(),
        });
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        const tableName = camelToSnake(name);
        tables[name] = zodToTable(tableName, zodSchema);
    }
    // 2. Create SQLite db
    const sqlite = new Database(dbPath);
    sqlite.run(`PRAGMA journal_mode = ${opts?.journalMode ?? "WAL"}`);
    // 30s timeout: concurrent worktrees each spawn agent processes that all write
    // to smithers.db simultaneously. 5s is too short and causes SQLITE_IOERR_VNODE
    // on macOS when the VFS can't acquire the WAL shared-memory lock in time.
    sqlite.run("PRAGMA busy_timeout = 30000");
    // NORMAL is safe in WAL mode (no data loss on crash) and reduces fsync
    // stalls that contribute to WAL checkpoint contention across processes.
    sqlite.run("PRAGMA synchronous = NORMAL");
    // Ensure no exclusive lock is held, allowing multiple readers/writers.
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    // Register a process-exit hook to explicitly close the Database.
    // bun:sqlite's GC finalizer calls sqlite3_close() which fatally aborts if
    // Drizzle's cached prepared statements haven't been finalized first.
    // Calling close() ourselves lets sqlite3 finalize everything gracefully.
    let dbClosed = false;
    const closeDb = () => {
        if (dbClosed)
            return;
        dbClosed = true;
        try {
            sqlite.close();
        }
        catch { }
    };
    process.on("exit", closeDb);
    // 3. Auto-create tables using CREATE TABLE IF NOT EXISTS
    if (schemas.input) {
        const inputDdl = zodToCreateTableSQL("input", schemas.input, { isInput: true });
        sqlite.run(inputDdl);
    }
    else {
        sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
        try {
            const cols = sqlite.query(`PRAGMA table_info("input")`).all();
            const hasPayload = cols.some((col) => col?.name === "payload");
            if (!hasPayload) {
                sqlite.run(`ALTER TABLE "input" ADD COLUMN payload TEXT`);
            }
        }
        catch {
            // ignore - older SQLite or permission issues; input payload remains best-effort
        }
    }
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        const tableName = camelToSnake(name);
        const ddl = zodToCreateTableSQL(tableName, zodSchema);
        sqlite.run(ddl);
    }
    // 4. Create Drizzle instance with all tables in the schema
    const drizzleSchema = { input: inputTable };
    for (const [key, table] of Object.entries(tables)) {
        drizzleSchema[key] = table;
    }
    const db = drizzle(sqlite, { schema: drizzleSchema });
    // 5. Build schema registry for engine resolution of string output keys
    const schemaRegistry = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        schemaRegistry.set(name, { table: tables[name], zodSchema });
    }
    // 6. Build reverse lookup: ZodObject reference → schema key name
    const zodToKeyName = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        zodToKeyName.set(zodSchema, name);
    }
    // 7. Context + hooks
    const { SmithersContext: RuntimeSmithersContext, useCtx, } = createSmithersContext();
    const ctxRef = { current: null };
    let moduleAlertPolicy = opts?.alertPolicy;
    /**
   * @param {WorkflowProps} props
   */
    function Workflow(props) {
        return React.createElement(BaseWorkflow, props, props.children);
    }
    /**
   * @template Row
   * @param {ApprovalProps<Row>} props
   */
    function Approval(props) {
        return React.createElement(BaseApproval, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
     * Task wrapper that resolves ZodObject output references against the
     * schema registry by reference equality, injecting the outputSchema.
     */
    function Task(props) {
        return React.createElement(BaseTask, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @param {SandboxProps} props
   */
    function Sandbox(props) {
        const workflow = props.workflow ??
            {
                db,
                build: () => React.createElement(BaseWorkflow, { name: `sandbox:${props.id}` }, props.children),
                opts: {},
                schemaRegistry,
                zodToKeyName,
            };
        return React.createElement(BaseSandbox, {
            ...props,
            workflow,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @template SignalSchema
   * @param {SignalProps<SignalSchema>} props
   */
    function Signal(props) {
        return React.createElement(BaseSignal, {
            ...props,
            smithersContext: RuntimeSmithersContext,
        });
    }
    /**
   * @param {(ctx: SmithersCtx<Schemas>) => React.ReactElement} build
   * @param {SmithersWorkflowOptions} [smithersOpts]
   * @returns {SmithersWorkflow<Schemas>}
   */
    function boundSmithers(build, smithersOpts) {
        const workflowOpts = {
            ...smithersOpts,
        };
        const alertPolicy = mergeAlertPolicies(moduleAlertPolicy, smithersOpts?.alertPolicy);
        if (alertPolicy)
            workflowOpts.alertPolicy = alertPolicy;
        return {
            readableName: opts?.readableName,
            description: opts?.description,
            db,
            build: (ctx) => {
                ctxRef.current = ctx;
                return React.createElement(RuntimeSmithersContext.Provider, { value: ctxRef.current }, React.createElement(GlobalSmithersContext.Provider, { value: ctxRef.current }, build(ctx)));
            },
            opts: workflowOpts,
            schemaRegistry,
            zodToKeyName,
        };
    }
    /**
   * @param {SmithersAlertPolicy} [alertPolicy]
   */
    const setModuleAlertPolicy = (alertPolicy) => {
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
        tables: tables,
        outputs: schemas,
    };
    if (process.env.SMITHERS_HOT === "1") {
        const sig = computeSchemaSig(schemas, absDbPath);
        hotCache.set(absDbPath, {
            api: api,
            schemaSig: sig,
            setModuleAlertPolicy,
        });
    }
    return api;
}
