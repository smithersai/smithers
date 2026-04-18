import { getTableName } from "drizzle-orm";
import { Effect, Metric, MetricBoundaries } from "effect";
import { getAgentOutputSchema, selectOutputRow, stripAutoColumns } from "@smithers-orchestrator/db/output";
import { buildOutputSchemaDescriptor } from "@smithers-orchestrator/db/output-schema-descriptor";
import { runPromise } from "../smithersRuntime.js";
import { NodeOutputRouteError } from "./NodeOutputRouteError.js";
import { NODE_OUTPUT_WARN_BYTES } from "./NODE_OUTPUT_WARN_BYTES.js";
import { NODE_OUTPUT_MAX_BYTES } from "./NODE_OUTPUT_MAX_BYTES.js";

/** @typedef {import("./NodeOutputResponse.js").NodeOutputResponse} NodeOutputResponse */

const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const INT32_MAX = 2_147_483_647;

const fastBucketsMs = MetricBoundaries.exponential({ start: 1, factor: 2, count: 12 });
const sizeBuckets = MetricBoundaries.exponential({ start: 100, factor: 2, count: 16 });

const nodeOutputRequestTotal = Metric.counter("smithers_node_output_request_total");
const nodeOutputBytes = Metric.histogram("smithers_node_output_bytes", sizeBuckets);
const nodeOutputDurationMs = Metric.histogram("smithers_node_output_duration_ms", fastBucketsMs);
const nodeOutputSchemaConversionErrorTotal = Metric.counter("smithers_node_output_schema_conversion_error_total");

/**
 * Wrap a promise-returning function in a real tracing span with attributes.
 * Mirrors the pattern used by getNodeDiffRoute: one Effect.withSpan, plus a
 * debug log carrying the span name and duration so log-only backends still
 * get a record of the child span.
 *
 * @template T
 * @param {(effect: Effect.Effect<void>) => Promise<unknown>} emitEffect
 * @param {string} spanName
 * @param {Record<string, unknown>} attrs
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function emitEffectSpan(emitEffect, spanName, attrs, run) {
    const startedAt = Date.now();
    try {
        const result = await runPromise(Effect.promise(() => run()).pipe(Effect.withSpan(spanName, { attributes: attrs })));
        await swallow(() => emitEffect(Effect.logDebug(spanName).pipe(Effect.annotateLogs({
            ...attrs,
            span: spanName,
            durationMs: Date.now() - startedAt,
        }))));
        return result;
    }
    catch (error) {
        await swallow(() => emitEffect(Effect.logError(`${spanName} failed`).pipe(Effect.annotateLogs({
            ...attrs,
            span: spanName,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        }))));
        throw error;
    }
}

/**
 * @param {() => Promise<void>} run
 */
async function swallow(run) {
    try {
        await run();
    }
    catch {
        // Observability must never break RPC responses.
    }
}

/**
 * Resolve per-node output row plus schema hints for DevTools rendering.
 *
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ workflow: import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<unknown>; adapter: import("@smithers-orchestrator/db/adapter").SmithersDb } | null>;
 *   selectOutputRowImpl?: typeof selectOutputRow;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 * }} params
 * @returns {Promise<NodeOutputResponse>}
 */
export async function getNodeOutputRoute(params) {
    const emitEffect = params.emitEffect ?? ((effect) => runPromise(effect));
    const startedAt = performance.now();
    let statusForMetrics = "error";
    let rowBytes = 0;
    let logRunId = asString(params.runId) ?? null;
    let logNodeId = asString(params.nodeId) ?? null;
    let logIteration = coerceOptionalInteger(params.iteration);
    let logErrorCode = null;
    const rootSpanAttrs = {
        runId: logRunId ?? "",
        nodeId: logNodeId ?? "",
        iteration: logIteration ?? -1,
        status: "unknown",
        bytes: 0,
    };
    try {
        const runId = parseRunId(params.runId);
        const nodeId = parseNodeId(params.nodeId);
        const iteration = parseIteration(params.iteration);
        logRunId = runId;
        logNodeId = nodeId;
        logIteration = iteration;
        rootSpanAttrs.runId = runId;
        rootSpanAttrs.nodeId = nodeId;
        rootSpanAttrs.iteration = iteration;

        const resolved = await params.resolveRun(runId);
        if (!resolved) {
            throw new NodeOutputRouteError("RunNotFound", `Run not found: ${runId}`);
        }

        const nodeIterations = await resolved.adapter.listNodeIterations(runId, nodeId);
        if (!Array.isArray(nodeIterations) || nodeIterations.length === 0) {
            throw new NodeOutputRouteError("NodeNotFound", `Node not found: ${nodeId}`);
        }

        const node = nodeIterations.find((entry) => (entry?.iteration ?? 0) === iteration);
        if (!node) {
            throw new NodeOutputRouteError("IterationNotFound", `Iteration not found: ${iteration}`);
        }

        const outputTableName = asString(node.outputTable)?.trim() ?? "";
        if (!outputTableName) {
            throw new NodeOutputRouteError("NodeHasNoOutput", `Node ${nodeId} has no output table.`);
        }

        const output = resolveOutputDefinition(resolved.workflow, outputTableName);
        if (!output?.table) {
            throw new NodeOutputRouteError("NodeHasNoOutput", `Output table ${outputTableName} is not registered.`);
        }

        const { descriptor, warnings } = await emitEffectSpan(
            emitEffect,
            "devtools.buildSchemaDescriptor",
            { runId, nodeId, iteration },
            async () => {
                const collected = [];
                const schemaForDescriptor = isDescriptorSchema(output.zodSchema)
                    ? output.zodSchema
                    : getAgentOutputSchema(output.table);
                const builtDescriptor = buildOutputSchemaDescriptor(schemaForDescriptor, {
                    onWarning: (warning) => collected.push(warning),
                });
                return { descriptor: builtDescriptor, warnings: collected };
            },
        );

        if (warnings.length > 0) {
            for (const warning of warnings) {
                await swallow(() => emitEffect(Effect.all([
                    Metric.increment(nodeOutputSchemaConversionErrorTotal),
                    Effect.logWarning("getNodeOutput schema conversion warning").pipe(Effect.annotateLogs({
                        runId,
                        nodeId,
                        iteration,
                        errorCode: warning.code,
                        field: warning.field,
                        construct: warning.construct,
                    })),
                ], { discard: true })));
            }
        }

        const selectOutputRowImpl = params.selectOutputRowImpl ?? selectOutputRow;
        let selectedRow;
        try {
            selectedRow = await emitEffectSpan(
                emitEffect,
                "db.outputs.select",
                { runId, nodeId, iteration },
                () => selectOutputRowImpl(resolved.workflow.db, output.table, {
                    runId,
                    nodeId,
                    iteration,
                }),
            );
        }
        catch (error) {
            if (looksLikeMalformedOutputRow(error)) {
                throw new NodeOutputRouteError("MalformedOutputRow", "Output row is not parseable JSON.");
            }
            throw error;
        }

        const hasRow = selectedRow !== undefined;
        let normalizedRow = null;
        if (hasRow) {
            normalizedRow = normalizeOutputRow(selectedRow);
            if (normalizedRow !== null && !isPlainObject(normalizedRow)) {
                throw new NodeOutputRouteError("MalformedOutputRow", "Output row must be a JSON object or null.");
            }
            rowBytes = byteLengthOfJson(normalizedRow);
            rootSpanAttrs.bytes = rowBytes;
            if (rowBytes > NODE_OUTPUT_MAX_BYTES) {
                throw new NodeOutputRouteError("PayloadTooLarge", `Output payload exceeds ${NODE_OUTPUT_MAX_BYTES} bytes.`);
            }
            if (rowBytes > NODE_OUTPUT_WARN_BYTES) {
                await swallow(() => emitEffect(Effect.logWarning("getNodeOutput large payload").pipe(Effect.annotateLogs({
                    runId,
                    nodeId,
                    iteration,
                    rowBytes,
                }))));
            }
        }

        if (hasRow) {
            statusForMetrics = "produced";
            rootSpanAttrs.status = "produced";
            return {
                status: "produced",
                row: normalizedRow,
                schema: descriptor,
            };
        }

        const attempts = await resolved.adapter.listAttempts(runId, nodeId, iteration);
        const latestAttempt = Array.isArray(attempts) ? attempts[0] : undefined;
        const failed =
            node.state === "failed" ||
                latestAttempt?.state === "failed" ||
                (typeof latestAttempt?.errorJson === "string" && latestAttempt.errorJson.length > 0);

        if (failed) {
            statusForMetrics = "failed";
            rootSpanAttrs.status = "failed";
            return {
                status: "failed",
                row: null,
                schema: descriptor,
                partial: parsePartialHeartbeat(latestAttempt?.heartbeatDataJson),
            };
        }

        statusForMetrics = "pending";
        rootSpanAttrs.status = "pending";
        return {
            status: "pending",
            row: null,
            schema: descriptor,
        };
    }
    catch (error) {
        if (error instanceof NodeOutputRouteError) {
            logErrorCode = error.code;
            if (error.code === "MalformedOutputRow") {
                await swallow(() => emitEffect(Effect.logError("getNodeOutput malformed row").pipe(Effect.annotateLogs({
                    runId: logRunId,
                    nodeId: logNodeId,
                    iteration: logIteration,
                    errorCode: error.code,
                }))));
            }
            throw error;
        }
        logErrorCode = asString(error?.code) ?? "ServerError";
        await swallow(() => emitEffect(Effect.logError("getNodeOutput failed").pipe(Effect.annotateLogs({
            runId: logRunId,
            nodeId: logNodeId,
            iteration: logIteration,
            errorCode: logErrorCode,
            errorMessage: asString(error?.message) ?? String(error),
        }))));
        throw error;
    }
    finally {
        const durationMs = Math.max(0, performance.now() - startedAt);
        rootSpanAttrs.bytes = rowBytes;
        // Root span wrapping the finalisation (one span per RPC).
        await swallow(() => runPromise(Effect.sync(() => {
            // No-op body; the span records start/end times and attributes.
        }).pipe(Effect.withSpan("devtools.getNodeOutput", {
            attributes: {
                ...rootSpanAttrs,
                status: statusForMetrics,
                bytes: rowBytes,
                durationMs,
                ...(logErrorCode ? { errorCode: logErrorCode } : {}),
            },
        }))));
        await swallow(() => emitEffect(Effect.all([
            Metric.increment(Metric.tagged(nodeOutputRequestTotal, "status", statusForMetrics)),
            Metric.update(nodeOutputBytes, rowBytes),
            Metric.update(nodeOutputDurationMs, durationMs),
            Effect.logInfo("getNodeOutput completed").pipe(Effect.annotateLogs({
                runId: logRunId,
                nodeId: logNodeId,
                iteration: logIteration,
                status: statusForMetrics,
                rowBytes,
                durationMs,
                ...(logErrorCode ? { errorCode: logErrorCode } : {}),
            })),
        ], { discard: true })));
    }
}

/**
 * @param {unknown} value
 */
function parseRunId(value) {
    const runId = asString(value);
    if (!runId || !RUN_ID_PATTERN.test(runId)) {
        throw new NodeOutputRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    }
    return runId;
}

/**
 * @param {unknown} value
 */
function parseNodeId(value) {
    const nodeId = asString(value);
    if (!nodeId || !NODE_ID_PATTERN.test(nodeId)) {
        throw new NodeOutputRouteError("InvalidNodeId", "nodeId must match /^[a-zA-Z0-9:_-]{1,128}$/.");
    }
    return nodeId;
}

/**
 * @param {unknown} value
 */
function parseIteration(value) {
    const normalized = coerceOptionalInteger(value);
    if (normalized === undefined || normalized < 0 || normalized > INT32_MAX) {
        throw new NodeOutputRouteError("InvalidIteration", "iteration must be a non-negative 32-bit integer.");
    }
    return normalized;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function coerceOptionalInteger(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
        return undefined;
    }
    return numeric;
}

/**
 * @param {unknown} workflow
 * @param {string} outputTableName
 * @returns {{ table: unknown; zodSchema?: unknown } | null}
 */
function resolveOutputDefinition(workflow, outputTableName) {
    const wf = /** @type {Record<string, unknown> | null | undefined} */ (
        workflow && typeof workflow === "object" ? workflow : null
    );
    const schemaRegistry = /** @type {{ get?: (key: string) => { table?: unknown; zodSchema?: unknown } | undefined; values?: () => Iterable<{ table?: unknown; zodSchema?: unknown }>; } | undefined} */ (
        wf?.schemaRegistry
    );
    if (schemaRegistry && typeof schemaRegistry.get === "function") {
        const hit = schemaRegistry.get(outputTableName);
        if (hit?.table) {
            return {
                table: hit.table,
                zodSchema: hit.zodSchema,
            };
        }
        if (typeof schemaRegistry.values === "function") {
            for (const entry of schemaRegistry.values()) {
                if (!entry?.table) {
                    continue;
                }
                try {
                    if (getTableName(entry.table) === outputTableName) {
                        return {
                            table: entry.table,
                            zodSchema: entry.zodSchema,
                        };
                    }
                }
                catch { }
            }
        }
    }

    const db = /** @type {Record<string, unknown> | undefined} */ (
        wf?.db && typeof wf.db === "object" ? wf.db : undefined
    );
    const dbInternal = /** @type {Record<string, unknown> | undefined} */ (
        db?._ && typeof db._ === "object" ? db._ : undefined
    );
    const candidates = [
        dbInternal?.fullSchema,
        dbInternal?.schema,
        db?.schema,
    ];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        const candidateRecord = /** @type {Record<string, unknown>} */ (candidate);
        const direct = candidateRecord[outputTableName];
        if (direct) {
            return { table: direct };
        }
        for (const table of Object.values(candidateRecord)) {
            try {
                if (getTableName(table) === outputTableName) {
                    return { table };
                }
            }
            catch { }
        }
    }

    return null;
}

/**
 * @param {unknown} value
 */
function isDescriptorSchema(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "shape" in value;
}

/**
 * @param {unknown} row
 * @returns {unknown}
 */
function normalizeOutputRow(row) {
    if (!row || typeof row !== "object") {
        return row ?? null;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    const keys = Object.keys(r);
    const payloadOnly =
        "payload" in r &&
            keys.every((key) => key === "runId" || key === "nodeId" || key === "iteration" || key === "payload");
    if (payloadOnly) {
        return r.payload ?? null;
    }
    return stripAutoColumns(r);
}

/**
 * @param {unknown} value
 */
function parsePartialHeartbeat(value) {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        return isPlainObject(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}

/**
 * @param {unknown} value
 */
function byteLengthOfJson(value) {
    let json;
    try {
        json = JSON.stringify(value);
    }
    catch {
        throw new NodeOutputRouteError("MalformedOutputRow", "Output row is not valid JSON.");
    }
    if (typeof json !== "string") {
        throw new NodeOutputRouteError("MalformedOutputRow", "Output row is not valid JSON.");
    }
    return Buffer.byteLength(json, "utf8");
}

/**
 * @param {unknown} error
 */
function looksLikeMalformedOutputRow(error) {
    if (error instanceof SyntaxError) {
        return true;
    }
    const message = asString(error?.message)?.toLowerCase() ?? "";
    return message.includes("json") || message.includes("parse") || message.includes("malformed");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 */
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
