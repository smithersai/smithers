import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq } from "drizzle-orm";
import { Context, Duration, Effect, Exit, Layer, Schedule, Schema, } from "effect";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { SmithersDb } from "@smithers/db/adapter";
import { runWorkflow } from "../engine.js";
import { ignoreSyncError } from "@smithers/driver/interop";
import { requireTaskRuntime } from "@smithers/driver/task-runtime";
import { Branch, Loop, Parallel, Sequence, Task, Worktree, Workflow, } from "@smithers/components/components/index";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
import { SmithersError } from "@smithers/errors/SmithersError";
/**
 * @typedef {import("effect").Schema.Schema<unknown, unknown, never>} AnySchema
 */
/**
 * @typedef {{ needs?: Record<string, BuilderStepHandle>; request: (ctx: Record<string, unknown>) => { title: string; summary?: string | null; }; onDeny?: "fail" | "continue" | "skip"; }} ApprovalOptions
 */
/** @typedef {import("./BuilderNode.ts").BuilderNode} BuilderNode */
/**
 * @typedef {Record<string, unknown> & { input: unknown; executionId: string; stepId: string; attempt: number; signal: AbortSignal; iteration: number; heartbeat: (data?: unknown) => void; lastHeartbeat: unknown | null; }} BuilderStepContext
 */
/** @typedef {import("./BuilderStepHandle.ts").BuilderStepHandle} BuilderStepHandle */
/** @typedef {import("@smithers/scheduler/RetryPolicy").RetryPolicy} RetryPolicy */
/** @typedef {import("./SmithersSqliteOptions.ts").SmithersSqliteOptions} SmithersSqliteOptions */

const SmithersSqlite = Context.GenericTag("smithers/effect/sqlite");
class ApprovalDecision extends Schema.Class("ApprovalDecision")({
    approved: Schema.Boolean,
    note: Schema.NullOr(Schema.String),
    decidedBy: Schema.NullOr(Schema.String),
    decidedAt: Schema.NullOr(Schema.String),
}) {
}
/**
 * @param {string} name
 */
function createPayloadTable(name) {
    return sqliteTable(name, {
        runId: text("run_id").notNull(),
        nodeId: text("node_id").notNull(),
        iteration: integer("iteration").notNull().default(0),
        payload: text("payload", { mode: "json" }).$type(),
    }, (t) => ({
        pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    }));
}
/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeIdentifier(value) {
    const snake = camelToSnake(value)
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
    return snake || "node";
}
/**
 * @param {string} id
 * @returns {string}
 */
function makeTableName(id) {
    return `smithers_${sanitizeIdentifier(id)}`;
}
/**
 * @returns {BuilderApi}
 */
function createBuilder(prefix = "") {
    /**
   * @param {string} id
   */
    const applyPrefix = (id) => (prefix ? `${prefix}.${id}` : id);
    /**
   * @param {string} id
   * @param {StepOptions} options
   * @returns {BuilderStepHandle}
   */
    const step = (id, options) => {
        const fullId = applyPrefix(id);
        const tableName = makeTableName(fullId);
        return {
            kind: "step",
            id: fullId,
            localId: id,
            tableKey: sanitizeIdentifier(fullId),
            tableName,
            table: createPayloadTable(tableName),
            output: options.output,
            needs: options.needs ?? {},
            run: options.run,
            retries: deriveRetryCount(options.retry),
            retryPolicy: options.retryPolicy ?? deriveRetryPolicy(options.retry),
            timeoutMs: durationToMs(options.timeout),
            skipIf: options.skipIf,
            cache: options.cache,
        };
    };
    /**
   * @param {string} id
   * @param {ApprovalOptions} options
   * @returns {BuilderStepHandle}
   */
    const approval = (id, options) => {
        const fullId = applyPrefix(id);
        const tableName = makeTableName(fullId);
        return {
            kind: "approval",
            id: fullId,
            localId: id,
            tableKey: sanitizeIdentifier(fullId),
            tableName,
            table: createPayloadTable(tableName),
            output: ApprovalDecision,
            needs: options.needs ?? {},
            request: options.request,
            onDeny: options.onDeny ?? "fail",
            retries: 0,
            timeoutMs: null,
        };
    };
    return {
        step,
        approval,
        sequence: (...nodes) => ({ kind: "sequence", children: nodes }),
        parallel: (...args) => {
            let maxConcurrency;
            const items = [...args];
            const last = items[items.length - 1];
            if (last &&
                typeof last === "object" &&
                !Array.isArray(last) &&
                !isBuilderNode(last) &&
                "maxConcurrency" in last) {
                maxConcurrency = Number(last.maxConcurrency);
                items.pop();
            }
            return {
                kind: "parallel",
                children: items,
                maxConcurrency,
            };
        },
        loop: (options) => ({
            kind: "loop",
            id: options.id ? applyPrefix(options.id) : undefined,
            children: options.children,
            until: options.until,
            maxIterations: options.maxIterations,
            onMaxReached: options.onMaxReached,
        }),
        match: (source, options) => ({
            kind: "match",
            source,
            when: options.when,
            then: options.then(),
            else: options.else?.(),
        }),
        component: (instanceId, definition, params) => definition.buildWithPrefix(applyPrefix(instanceId), params),
    };
}
/**
 * @param {unknown} value
 * @returns {value is BuilderNode}
 */
function isBuilderNode(value) {
    if (!value || typeof value !== "object")
        return false;
    const kind = value.kind;
    return kind === "step" ||
        kind === "approval" ||
        kind === "sequence" ||
        kind === "parallel" ||
        kind === "loop" ||
        kind === "match" ||
        kind === "branch" ||
        kind === "worktree";
}
/**
 * @param {unknown} input
 * @returns {number | null}
 */
function durationToMs(input) {
    if (input == null)
        return null;
    if (typeof input === "string") {
        const trimmed = input.trim();
        const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)$/i);
        if (match) {
            const value = Number(match[1]);
            if (Number.isFinite(value)) {
                const unit = match[2].toLowerCase();
                const factor = unit === "ms"
                    ? 1
                    : unit === "s"
                        ? 1000
                        : unit === "m"
                            ? 60_000
                            : 3_600_000;
                return Math.max(0, Math.floor(value * factor));
            }
        }
    }
    if (typeof input === "number" && Number.isFinite(input)) {
        return Math.max(0, Math.floor(input));
    }
    try {
        return Math.max(0, Math.floor(Duration.toMillis(Duration.decode(input))));
    }
    catch {
        return null;
    }
}
/**
 * @param {unknown} retry
 * @returns {RetryPolicy | undefined}
 */
function deriveRetryPolicy(retry) {
    if (!retry || typeof retry !== "object")
        return undefined;
    const backoff = retry.backoff;
    const initialDelayMs = durationToMs(retry.initialDelay);
    if (backoff !== "fixed" &&
        backoff !== "linear" &&
        backoff !== "exponential" &&
        initialDelayMs == null) {
        return undefined;
    }
    return {
        backoff: backoff === "fixed" || backoff === "linear" || backoff === "exponential"
            ? backoff
            : undefined,
        initialDelayMs: initialDelayMs ?? undefined,
    };
}
/**
 * @param {unknown} retry
 * @returns {number}
 */
function deriveRetryCount(retry) {
    if (retry == null)
        return 0;
    if (typeof retry === "number" && Number.isFinite(retry)) {
        return Math.max(0, Math.floor(retry));
    }
    if (typeof retry === "object" && retry !== null) {
        const maxAttempts = retry.maxAttempts;
        if (typeof maxAttempts === "number" && Number.isFinite(maxAttempts)) {
            return Math.max(0, Math.floor(maxAttempts - 1));
        }
    }
    try {
        const driver = Effect.runSync(Schedule.driver(retry));
        let count = 0;
        while (count < 100) {
            const exit = Effect.runSyncExit(driver.next(undefined));
            if (Exit.isFailure(exit)) {
                return count;
            }
            count += 1;
        }
        return count;
    }
    catch {
        return 0;
    }
}
/**
 * @template T
 * @param {AnySchema} schema
 * @param {unknown} value
 * @returns {T}
 */
function decodeSchema(schema, value) {
    return Schema.decodeUnknownSync(schema)(value);
}
/**
 * @param {AnySchema} schema
 * @param {unknown} value
 */
function encodeSchema(schema, value) {
    return Schema.encodeSync(schema)(value);
}
/**
 * @param {BuilderStepHandle} handle
 * @param {{ iteration?: number; iterations?: Record<string, number>; }} ctx
 * @returns {number}
 */
function resolveHandleIteration(handle, ctx) {
    if (handle.loopId) {
        return ctx.iterations?.[handle.loopId] ?? 0;
    }
    return 0;
}
/**
 * @param {Record<string, unknown>} row
 */
function stripPersistedKeys(row) {
    const { runId, nodeId, iteration, payload, ...rest } = row;
    if (payload !== undefined)
        return payload;
    return rest;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
function readHandleMaybe(handle, ctx) {
    const iteration = resolveHandleIteration(handle, ctx);
    const row = ctx.outputMaybe(handle.tableName, {
        nodeId: handle.id,
        iteration,
    });
    if (!row)
        return undefined;
    return decodeSchema(handle.output, stripPersistedKeys(row));
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
function readHandle(handle, ctx) {
    const value = readHandleMaybe(handle, ctx);
    if (value === undefined) {
        throw new SmithersError("MISSING_OUTPUT", `Missing output for step "${handle.id}"`, {
            nodeId: handle.id,
        });
    }
    return value;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 * @returns {BuilderStepContext}
 */
function buildUserContext(handle, ctx, decodedInput, runtime) {
    const data = {};
    for (const [key, dependency] of Object.entries(handle.needs)) {
        data[key] = readHandle(dependency, ctx);
    }
    return {
        ...data,
        input: decodedInput,
        executionId: runtime?.runId ?? ctx.runId,
        stepId: handle.id,
        attempt: runtime?.attempt ?? 1,
        signal: runtime?.signal ?? new AbortController().signal,
        iteration: runtime?.iteration ?? resolveHandleIteration(handle, ctx),
        heartbeat: runtime?.heartbeat ?? (() => { }),
        lastHeartbeat: runtime?.lastHeartbeat ?? null,
    };
}
/**
 * @param {Record<string, BuilderStepHandle> | undefined} needs
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 */
function buildNeedsContext(needs, ctx, decodedInput, runtime) {
    const data = {};
    if (needs) {
        for (const [key, dependency] of Object.entries(needs)) {
            data[key] = readHandleMaybe(dependency, ctx);
        }
    }
    const iteration = runtime?.iteration ??
        (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
    return {
        ...data,
        input: decodedInput,
        executionId: runtime?.runId ?? ctx.runId,
        stepId: runtime?.stepId ?? "",
        attempt: runtime?.attempt ?? 1,
        signal: runtime?.signal ?? new AbortController().signal,
        iteration,
        heartbeat: runtime?.heartbeat ?? (() => { }),
        lastHeartbeat: runtime?.lastHeartbeat ?? null,
        loop: { iteration: iteration + 1 },
    };
}
/**
 * @param {unknown} value
 * @param {any} env
 * @param {AbortSignal} signal
 */
async function resolveEffectResult(value, env, signal) {
    if (Effect.isEffect?.(value)) {
        return await Effect.runPromise(value.pipe(Effect.provide(env)), { signal });
    }
    if (value && typeof value.then === "function") {
        const resolved = await value;
        if (Effect.isEffect?.(resolved)) {
            return await Effect.runPromise(resolved.pipe(Effect.provide(env)), { signal });
        }
        return resolved;
    }
    return value;
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 */
async function executeStepHandle(handle, ctx, decodedInput, env) {
    const runtime = requireTaskRuntime();
    if (handle.kind === "approval") {
        const adapter = new SmithersDb(runtime.db);
        const approval = await adapter.getApproval(runtime.runId, handle.id, runtime.iteration);
        return encodeSchema(ApprovalDecision, {
            approved: approval?.status === "approved",
            note: approval?.note ?? null,
            decidedBy: approval?.decidedBy ?? null,
            decidedAt: null,
        });
    }
    const userCtx = buildUserContext(handle, ctx, decodedInput, runtime);
    const output = await resolveEffectResult(handle.run?.(userCtx), env, runtime.signal);
    const decoded = decodeSchema(handle.output, output);
    return encodeSchema(handle.output, decoded);
}
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @returns {boolean}
 */
function evaluateSkip(handle, ctx, decodedInput) {
    if (!handle.skipIf)
        return false;
    try {
        return Boolean(handle.skipIf(buildUserContext(handle, ctx, decodedInput)));
    }
    catch {
        return false;
    }
}
/**
 * @param {BuilderNode} node
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 * @returns {React.ReactNode}
 */
function renderNode(node, ctx, decodedInput, env) {
    if (node.kind === "step" || node.kind === "approval") {
        const requestInfo = node.kind === "approval"
            ? (() => {
                if (!node.request)
                    return null;
                const entries = Object.entries(node.needs).map(([key, dep]) => [
                    key,
                    readHandleMaybe(dep, ctx),
                ]);
                if (entries.some(([, value]) => value === undefined)) {
                    return null;
                }
                return node.request(Object.fromEntries(entries));
            })()
            : null;
        const compute = () => executeStepHandle(node, ctx, decodedInput, env);
        const needsMap = Object.keys(node.needs).length > 0
            ? Object.fromEntries(Object.entries(node.needs).map(([key, dep]) => [key, dep.id]))
            : undefined;
        return (React.createElement(Task, {
            id: node.id,
            output: node.table,
            retries: node.retries,
            retryPolicy: node.retryPolicy,
            timeoutMs: node.timeoutMs,
            cache: node.cache,
            skipIf: evaluateSkip(node, ctx, decodedInput),
            needsApproval: node.kind === "approval",
            approvalMode: node.kind === "approval" ? "decision" : undefined,
            approvalOnDeny: node.kind === "approval" ? node.onDeny : undefined,
            needs: needsMap,
            dependsOn: Object.values(node.needs).map((dep) => dep.id),
            label: requestInfo?.title,
            meta: requestInfo?.summary
                ? { requestSummary: requestInfo.summary }
                : undefined,
            children: compute,
        }));
    }
    if (node.kind === "sequence") {
        return React.createElement(Sequence, null, node.children.map((child, index) => React.createElement(React.Fragment, { key: `sequence-${index}` }, renderNode(child, ctx, decodedInput, env))));
    }
    if (node.kind === "parallel") {
        return React.createElement(Parallel, { maxConcurrency: node.maxConcurrency }, node.children.map((child, index) => React.createElement(React.Fragment, { key: `parallel-${index}` }, renderNode(child, ctx, decodedInput, env))));
    }
    if (node.kind === "loop") {
        const outputs = {};
        for (const handle of node.handles ?? []) {
            outputs[handle.localId] = readHandleMaybe(handle, ctx);
        }
        const iteration = (node.id && ctx?.iterations && typeof ctx.iterations[node.id] === "number")
            ? ctx.iterations[node.id]
            : (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
        const evalCtx = {
            ...outputs,
            input: decodedInput,
            iteration,
            loop: { iteration: iteration + 1 },
        };
        return React.createElement(Loop, {
            id: node.id,
            until: Boolean(node.until(evalCtx)),
            maxIterations: node.maxIterations,
            onMaxReached: node.onMaxReached,
        }, renderNode(node.children, ctx, decodedInput, env));
    }
    if (node.kind === "branch") {
        const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
        const chooseThen = Boolean(node.condition(baseCtx));
        return React.createElement(Branch, {
            if: chooseThen,
            then: React.createElement(React.Fragment, null, renderNode(node.then, ctx, decodedInput, env)),
            else: node.else
                ? React.createElement(React.Fragment, null, renderNode(node.else, ctx, decodedInput, env))
                : undefined,
        });
    }
    if (node.kind === "worktree") {
        const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
        const skip = node.skipIf ? Boolean(node.skipIf(baseCtx)) : false;
        return React.createElement(Worktree, { id: node.id, path: node.path, branch: node.branch, skipIf: skip }, renderNode(node.children, ctx, decodedInput, env));
    }
    if (node.kind === "match") {
        const sourceValue = readHandleMaybe(node.source, ctx);
        const chooseThen = sourceValue !== undefined && node.when(sourceValue);
        return React.createElement(Branch, {
            if: chooseThen,
            then: React.createElement(React.Fragment, null, renderNode(node.then, ctx, decodedInput, env)),
            else: node.else
                ? React.createElement(React.Fragment, null, renderNode(node.else, ctx, decodedInput, env))
                : undefined,
        });
    }
    return null;
}
/**
 * @param {BuilderNode} node
 * @param {BuilderStepHandle[]} [out]
 */
function collectHandles(node, out = []) {
    switch (node.kind) {
        case "step":
        case "approval":
            out.push(node);
            return out;
        case "sequence":
        case "parallel":
            for (const child of node.children)
                collectHandles(child, out);
            return out;
        case "loop":
            collectHandles(node.children, out);
            return out;
        case "match":
            collectHandles(node.then, out);
            if (node.else)
                collectHandles(node.else, out);
            return out;
        case "branch":
            collectHandles(node.then, out);
            if (node.else)
                collectHandles(node.else, out);
            return out;
        case "worktree":
            collectHandles(node.children, out);
            return out;
    }
}
/**
 * @param {BuilderStepHandle[]} handles
 */
function assertUniqueHandleIds(handles) {
    const seen = new Set();
    for (const handle of handles) {
        if (seen.has(handle.id)) {
            throw new SmithersError("DUPLICATE_ID", `Duplicate step id "${handle.id}"`, {
                kind: handle.kind,
                id: handle.id,
            });
        }
        seen.add(handle.id);
    }
}
/**
 * @param {BuilderNode} node
 * @param {string} [activeLoopId]
 * @returns {BuilderStepHandle[]}
 */
function annotateLoops(node, activeLoopId) {
    switch (node.kind) {
        case "step":
        case "approval":
            node.loopId = activeLoopId;
            return [node];
        case "sequence":
        case "parallel":
            return node.children.flatMap((child) => annotateLoops(child, activeLoopId));
        case "loop": {
            if (activeLoopId) {
                throw new SmithersError("NESTED_LOOP", "Nested builder loops are not supported.");
            }
            const handles = annotateLoops(node.children, node.id ?? "__loop__");
            node.handles = handles;
            return handles;
        }
        case "match":
            return [
                ...annotateLoops(node.then, activeLoopId),
                ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
            ];
        case "branch":
            return [
                ...annotateLoops(node.then, activeLoopId),
                ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
            ];
        case "worktree":
            return annotateLoops(node.children, activeLoopId);
    }
}
function createInputTable() {
    return sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type(),
    });
}
/**
 * @param {string} filename
 * @param {BuilderStepHandle[]} handles
 */
function createBuilderDb(filename, handles) {
    const sqlite = new Database(filename);
    sqlite.run("PRAGMA journal_mode = WAL");
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
    sqlite.run(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
    for (const handle of handles) {
        sqlite.run(`CREATE TABLE IF NOT EXISTS "${handle.tableName}" (` +
            `run_id TEXT NOT NULL, ` +
            `node_id TEXT NOT NULL, ` +
            `iteration INTEGER NOT NULL DEFAULT 0, ` +
            `payload TEXT, ` +
            `PRIMARY KEY (run_id, node_id, iteration)` +
            `)`);
    }
    const inputTable = createInputTable();
    const schema = { input: inputTable };
    for (const handle of handles) {
        schema[handle.tableKey] = handle.table;
    }
    const db = drizzle(sqlite, { schema });
    return {
        sqlite,
        db,
        inputTable,
        schema,
    };
}
/**
 * @param {any} db
 * @param {string} runId
 * @param {BuilderStepHandle} handle
 */
async function readLatestHandleResult(db, runId, handle) {
    const rows = await db
        .select()
        .from(handle.table)
        .where(and(eq(handle.table.runId, runId), eq(handle.table.nodeId, handle.id)))
        .orderBy(desc(handle.table.iteration))
        .limit(1);
    const row = rows[0];
    if (!row)
        return undefined;
    return decodeSchema(handle.output, stripPersistedKeys(row));
}
/**
 * @param {BuilderNode} node
 * @param {any} db
 * @param {string} runId
 * @param {unknown} [decodedInput]
 * @returns {Promise<unknown>}
 */
async function extractResult(node, db, runId, decodedInput) {
    switch (node.kind) {
        case "step":
        case "approval":
            return readLatestHandleResult(db, runId, node);
        case "sequence": {
            const last = node.children[node.children.length - 1];
            return last ? extractResult(last, db, runId, decodedInput) : undefined;
        }
        case "parallel":
            return Promise.all(node.children.map((child) => extractResult(child, db, runId, decodedInput)));
        case "loop":
            return extractResult(node.children, db, runId, decodedInput);
        case "match": {
            const source = await readLatestHandleResult(db, runId, node.source);
            if (source !== undefined && node.when(source)) {
                return extractResult(node.then, db, runId, decodedInput);
            }
            return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
        }
        case "branch": {
            const ctx = {
                input: decodedInput ?? {},
                iteration: 0,
                loop: { iteration: 1 },
            };
            if (node.needs) {
                for (const [key, handle] of Object.entries(node.needs)) {
                    ctx[key] = await readLatestHandleResult(db, runId, handle);
                }
            }
            if (node.condition(ctx)) {
                return extractResult(node.then, db, runId, decodedInput);
            }
            return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
        }
        case "worktree":
            return extractResult(node.children, db, runId, decodedInput);
    }
}
/**
 * @param {{ status: string; error?: unknown }} result
 */
function normalizeExecutionError(result) {
    if (result.error instanceof Error)
        return result.error;
    if (typeof result.error === "string" && result.error.length > 0) {
        return new SmithersError("WORKFLOW_EXECUTION_FAILED", result.error, {
            status: result.status,
        });
    }
    return new SmithersError("WORKFLOW_EXECUTION_FAILED", `Workflow execution ended with status "${result.status}"`, { status: result.status });
}
/**
 * @param {{ name: string; input: AnySchema }} options
 */
function createWorkflow(options) {
    return {
        /**
     * @param {($: BuilderApi) => BuilderNode} buildGraph
     * @returns {BuiltSmithersWorkflow}
     */
        build(buildGraph) {
            const root = buildGraph(createBuilder());
            annotateLoops(root);
            const handles = collectHandles(root);
            assertUniqueHandleIds(handles);
            return {
                /**
         * @param {unknown} input
         * @param {Omit<Parameters<typeof runWorkflow>[1], "input">} [opts]
         */
                execute(input, opts) {
                    return Effect.gen(function* () {
                        const env = yield* Effect.context();
                        const sqliteConfig = yield* SmithersSqlite;
                        const decodedInput = decodeSchema(options.input, input);
                        const encodedInput = JSON.parse(JSON.stringify(encodeSchema(options.input, decodedInput) ?? {}));
                        return yield* Effect.acquireUseRelease(Effect.sync(() => createBuilderDb(sqliteConfig.filename, handles)), (runtime) => Effect.promise(async () => {
                            const workflow = {
                                db: runtime.db,
                                build: (ctx) => React.createElement(Workflow, { name: options.name }, renderNode(ctx && root ? root : root, ctx, decodedInput, env)),
                                opts: {},
                            };
                            const result = await Effect.runPromise(runWorkflow(workflow, {
                                ...opts,
                                input: encodedInput,
                            }));
                            if (result.status === "finished") {
                                return await extractResult(root, runtime.db, result.runId, decodedInput);
                            }
                            if (result.status === "waiting-approval" ||
                                result.status === "waiting-timer") {
                                return result;
                            }
                            throw normalizeExecutionError(result);
                        }), (runtime) => ignoreSyncError("close builder sqlite", () => runtime.sqlite.close()));
                    });
                },
            };
        },
    };
}
/**
 * @param {{ name: string; params?: Record<string, unknown> }} options
 */
function createComponent(options) {
    return {
        /**
     * @param {($: BuilderApi, params: Record<string, unknown>) => BuilderNode} buildGraph
     * @returns {ComponentDefinition}
     */
        build(buildGraph) {
            return {
                kind: "component-definition",
                name: options.name,
                /**
         * @param {string} prefix
         * @param {Record<string, unknown>} params
         */
                buildWithPrefix(prefix, params) {
                    return buildGraph(createBuilder(prefix), params);
                },
            };
        },
    };
}
/**
 * @param {SmithersSqliteOptions} options
 */
function sqlite(options) {
    return Layer.succeed(SmithersSqlite, options);
}
/** @type {{ sqlite: typeof sqlite }} */
export const Smithers = {
    sqlite,
};
