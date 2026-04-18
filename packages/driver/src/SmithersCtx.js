import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { buildCurrentScopes } from "./buildCurrentScopes.js";
import { filterRowsByNodeId } from "./filterRowsByNodeId.js";
import { normalizeInputRow } from "./normalizeInputRow.js";
import { withLogicalIterationShortcuts } from "./withLogicalIterationShortcuts.js";
/** @typedef {import("./OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("./SafeParser.ts").SafeParser} SafeParser */
/** @typedef {import("./SmithersCtxOptions.ts").SmithersCtxOptions} SmithersCtxOptions */
/** @typedef {import("./RunAuthContext.ts").RunAuthContext} RunAuthContext */
/** @typedef {import("./SmithersRuntimeConfig.ts").SmithersRuntimeConfig} SmithersRuntimeConfig */
/** @typedef {unknown} TableRef */
/** @typedef {Record<string, unknown> & { iteration?: number; nodeId?: string }} OutputRow */
/**
 * @template Schema
 * @typedef {import("./OutputAccessor.ts").OutputAccessor<Schema>} OutputAccessor
 */

/**
 * @param {TableRef} table
 * @returns {string | undefined}
 */
function resolveDrizzleName(table) {
    if (!table || typeof table !== "object")
        return undefined;
    const tableObj = /** @type {Record<string, unknown>} */ (table);
    const tableMeta = tableObj._;
    if (tableMeta &&
        typeof tableMeta === "object" &&
        typeof (/** @type {Record<string, unknown>} */ (tableMeta)).name === "string") {
        return /** @type {string} */ ((/** @type {Record<string, unknown>} */ (tableMeta)).name);
    }
    if (typeof tableObj.name === "string")
        return /** @type {string} */ (tableObj.name);
    return undefined;
}

/**
 * @template {unknown} [Schema=unknown]
 */
export class SmithersCtx {
    /** @type {string} */
    runId;
    /** @type {number} */
    iteration;
    /** @type {Record<string, number> | undefined} */
    iterations;
    /** @type {Schema extends { input: infer T } ? T : unknown} */
    input;
    /** @type {RunAuthContext | null} */
    auth;
    /** @type {SmithersRuntimeConfig | null | undefined} */
    __smithersRuntime;
    /** @type {OutputAccessor<Schema>} */
    outputs;
    /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
    _outputs;
    /** @type {Map<unknown, string> | undefined} */
    _zodToKeyName;
    /** @type {Set<string>} */
    _currentScopes;
    /**
     * @param {SmithersCtxOptions} opts
     */
    constructor(opts) {
        this.runId = opts.runId;
        this.iteration = opts.iteration;
        this.iterations = withLogicalIterationShortcuts(opts.iterations);
        this.input = /** @type {Schema extends { input: infer T } ? T : unknown} */ (normalizeInputRow(opts.input));
        this.auth = opts.auth ?? null;
        this.__smithersRuntime = opts.runtimeConfig ?? null;
        this._outputs = opts.outputs;
        this._zodToKeyName = opts.zodToKeyName;
        this._currentScopes = buildCurrentScopes(this.iterations);
        /**
         * @param {string} table
         */
        const outputsFn = (table) => opts.outputs[table] ?? [];
        for (const [name, rows] of Object.entries(opts.outputs)) {
            outputsFn[name] = rows;
        }
        this.outputs = /** @type {OutputAccessor<Schema>} */ (/** @type {unknown} */ (outputsFn));
    }
    /**
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {OutputRow}
     */
    output(table, key) {
        const row = this.resolveRow(table, key);
        if (!row) {
            throw new SmithersError("MISSING_OUTPUT", `Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`, { nodeId: key.nodeId, iteration: key.iteration ?? 0 });
        }
        return row;
    }
    /**
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {OutputRow | undefined}
     */
    outputMaybe(table, key) {
        return this.resolveRow(table, key);
    }
    /**
     * @param {TableRef} table
     * @param {string} nodeId
     * @returns {OutputRow | undefined}
     */
    latest(table, nodeId) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
        /** @type {OutputRow | undefined} */
        let best = undefined;
        let bestIteration = -Infinity;
        for (const row of matching) {
            const iter = Number.isFinite(Number(row.iteration))
                ? Number(row.iteration)
                : 0;
            if (!best || iter >= bestIteration) {
                best = row;
                bestIteration = iter;
            }
        }
        return best;
    }
    /**
     * @param {unknown} value
     * @param {SafeParser} schema
     * @returns {unknown[]}
     */
    latestArray(value, schema) {
        if (value == null)
            return [];
        let arr;
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value);
                arr = Array.isArray(parsed) ? parsed : [parsed];
            }
            catch {
                return [];
            }
        }
        else {
            arr = Array.isArray(value) ? value : [value];
        }
        return arr.flatMap((item) => {
            const parsed = schema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
        });
    }
    /**
     * @param {TableRef} table
     * @param {string} nodeId
     * @returns {number}
     */
    iterationCount(table, nodeId) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, nodeId, this._currentScopes);
        const seen = new Set();
        for (const row of matching) {
            const iter = Number.isFinite(Number(row.iteration))
                ? Number(row.iteration)
                : 0;
            seen.add(iter);
        }
        return seen.size;
    }
    /**
     * @param {TableRef} table
     * @returns {string}
     */
    resolveTableName(table) {
        if (typeof table === "string")
            return table;
        const zodKey = this._zodToKeyName?.get(table);
        if (zodKey)
            return zodKey;
        return resolveDrizzleName(table) ?? String(table);
    }
    /**
     * @param {TableRef} table
     * @param {OutputKey} key
     * @returns {OutputRow | undefined}
     */
    resolveRow(table, key) {
        const tableName = this.resolveTableName(table);
        const rows = this._outputs[tableName] ?? [];
        const matching = filterRowsByNodeId(rows, key.nodeId, this._currentScopes);
        return matching.find((row) => {
            return (row.iteration ?? 0) === (key.iteration ?? this.iteration);
        });
    }
}
