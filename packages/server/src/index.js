import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve, dirname, sep, basename } from "node:path";
import { Effect } from "effect";
import { isRunHeartbeatFresh, runWorkflow } from "@smithers-orchestrator/engine";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { Metric } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { logError, logInfo, logWarning } from "@smithers-orchestrator/observability/logging";
import { runPromise, runSync } from "./smithersRuntime.js";
import { httpRequests, httpRequestDuration, trackEvent } from "@smithers-orchestrator/observability/metrics";
import { approveNode, denyNode } from "@smithers-orchestrator/engine/approvals";
import { signalRun } from "@smithers-orchestrator/engine/signals";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { assertMaxBytes, assertMaxJsonDepth } from "@smithers-orchestrator/db/input-bounds";
import { prometheusContentType, renderPrometheusMetrics, } from "@smithers-orchestrator/observability";
/** @typedef {import("./ServerOptions.js").ServerOptions} ServerOptions */

// Re-export the full public surface so the tsup-bundled `src/index.d.ts`
// covers every module reachable via the `./*` wildcard export.
export * from "./gateway.js";
export * from "./serve.js";
export * from "./smithersRuntime.js";
export * from "./gatewayRoutes/NODE_OUTPUT_MAX_BYTES.js";
export * from "./gatewayRoutes/NODE_OUTPUT_WARN_BYTES.js";
export * from "./gatewayRoutes/NodeOutputRouteError.js";
export * from "./gatewayRoutes/getDevToolsSnapshot.js";
export * from "./gatewayRoutes/getNodeDiff.js";
export * from "./gatewayRoutes/getNodeOutput.js";
export * from "./gatewayRoutes/jumpToFrame.js";
export * from "./gatewayRoutes/streamDevTools.js";
// Type-only stubs reachable via `./*` that are NOT already transitively
// re-exported through the JS modules above.
export * from "./ServerOptions.js";

const runs = new Map();
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_BODY_JSON_DEPTH = 32;
const DEFAULT_SSE_HEARTBEAT_MS = 10_000;
const COMPLETED_RUN_RETENTION_MS = 60_000;
class HttpError extends Error {
    status;
    code;
    details;
    /**
   * @param {number} status
   * @param {HttpErrorCode} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
/**
 * @param {string | null} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(value, fallback) {
    if (value === null)
        return fallback;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        throw new HttpError(400, "INVALID_REQUEST", `Expected a positive integer, got "${value}"`);
    }
    return Math.floor(num);
}
/**
 * @param {string | null} value
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalInt(value, fallback) {
    if (value === null)
        return fallback;
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw new HttpError(400, "INVALID_REQUEST", `Expected a number, got "${value}"`);
    }
    return Math.floor(num);
}
/**
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @param {number} maxDepth
 * @returns {Promise<unknown>}
 */
async function readBody(req, maxBytes, maxDepth) {
    const chunks = [];
    let total = 0;
    const lengthHeader = req.headers["content-length"];
    if (lengthHeader) {
        const len = Array.isArray(lengthHeader)
            ? Number(lengthHeader[0])
            : Number(lengthHeader);
        if (Number.isFinite(len) && len > maxBytes) {
            throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, { maxBytes });
        }
    }
    for await (const chunk of req) {
        const buf = Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, { maxBytes });
        }
        chunks.push(buf);
    }
    const bodyBuffer = Buffer.concat(chunks);
    try {
        assertMaxBytes("request body", bodyBuffer, maxBytes);
    }
    catch (error) {
        if (error instanceof SmithersError) {
            throw new HttpError(413, "PAYLOAD_TOO_LARGE", error.message, {
                maxBytes,
            });
        }
        throw error;
    }
    const body = bodyBuffer.toString("utf8");
    if (!body)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch (err) {
        throw new HttpError(400, "INVALID_JSON", err?.message ?? "Request body must be valid JSON");
    }
    try {
        assertMaxJsonDepth("request body", parsed, maxDepth);
    }
    catch (error) {
        if (error instanceof SmithersError) {
            throw new HttpError(400, "INVALID_REQUEST", error.message, {
                maxDepth,
            });
        }
        throw error;
    }
    return parsed;
}
/**
 * @param {string} absPath
 * @returns {Promise<SmithersWorkflow<unknown>>}
 */
async function loadWorkflow(absPath) {
    const source = await readFile(absPath);
    const version = createHash("sha1").update(source).digest("hex");
    const extIdx = absPath.lastIndexOf(".");
    const ext = extIdx >= 0 ? absPath.slice(extIdx) : "";
    const base = basename(absPath, ext);
    const shadowPath = resolve(dirname(absPath), `.${base}.smithers-${version}${ext}`);
    await writeFile(shadowPath, source);
    const mod = await import(pathToFileURL(shadowPath).href);
    if (!mod.default)
        throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "Workflow must export default");
    return mod.default;
}
/**
 * @param {string} absPath
 */
function loadWorkflowEffect(absPath) {
    return Effect.tryPromise({
        try: () => loadWorkflow(absPath),
        catch: (cause) => toSmithersError(cause, "load workflow module"),
    }).pipe(Effect.annotateLogs({ workflowPath: absPath }), Effect.withLogSpan("server:load-workflow"));
}
/**
 * @param {RunRecord | undefined} record
 */
function clearRunCleanupTimer(record) {
    if (!record?.cleanupTimer)
        return;
    clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
}
/**
 * @param {string} runId
 */
function scheduleRunCleanup(runId) {
    const record = runs.get(runId);
    if (!record)
        return;
    clearRunCleanupTimer(record);
    record.cleanupTimer = setTimeout(() => {
        const current = runs.get(runId);
        if (current === record) {
            runs.delete(runId);
        }
    }, COMPLETED_RUN_RETENTION_MS);
}
/**
 * @param {string} runId
 * @param {string} status
 * @param {boolean} hasServerDb
 */
function finalizeRunRecord(runId, status, hasServerDb) {
    if (hasServerDb ||
        (status !== "waiting-approval" && status !== "waiting-timer")) {
        if (hasServerDb) {
            const record = runs.get(runId);
            clearRunCleanupTimer(record);
            runs.delete(runId);
            return;
        }
        scheduleRunCleanup(runId);
    }
}
/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(JSON.stringify(payload));
}
/** @typedef {import("@smithers-orchestrator/db/adapter/RunRow").RunRow} RunRow */

/**
 * @param {SmithersDb} adapter
 * @param {RunRow} run
 * @returns {Promise<RunRow | (RunRow & { runState: import("@smithers-orchestrator/db/runState/RunStateView").RunStateView })>}
 */
async function withRunState(adapter, run) {
    const runState = await computeRunStateFromRow(adapter, run).catch(() => undefined);
    return runState ? { ...run, runState } : run;
}
/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} payload
 */
function sendText(res, status, payload, contentType = "text/plain; charset=utf-8") {
    res.statusCode = status;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(payload);
}
/**
 * @template A
 * @param {A} metric
 * @param {Record<string, string>} tags
 * @returns {A}
 */
function taggedMetric(metric, tags) {
    let tagged = metric;
    for (const [key, value] of Object.entries(tags)) {
        tagged = Metric.tagged(tagged, key, value);
    }
    return tagged;
}
/**
 * @param {string} pathname
 * @returns {string}
 */
function normalizeHttpMetricRoute(pathname) {
    if (pathname === "/metrics" || pathname === "/health" || pathname === "/v1/runs") {
        return pathname;
    }
    if (pathname === "/v1/approval/list"
        || pathname === "/v1/approvals"
        || pathname === "/approval/list"
        || pathname === "/approvals") {
        return pathname;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(pathname))
        return "/v1/runs/:runId/events";
    if (/^\/v1\/runs\/[^/]+\/frames$/.test(pathname))
        return "/v1/runs/:runId/frames";
    if (/^\/v1\/runs\/[^/]+\/nodes\/[^/]+\/approve$/.test(pathname)) {
        return "/v1/runs/:runId/nodes/:nodeId/approve";
    }
    if (/^\/v1\/runs\/[^/]+\/nodes\/[^/]+\/deny$/.test(pathname)) {
        return "/v1/runs/:runId/nodes/:nodeId/deny";
    }
    if (/^\/v1\/runs\/[^/]+\/signals\/[^/]+$/.test(pathname)) {
        return "/v1/runs/:runId/signals/:signalName";
    }
    if (/^\/signal\/[^/]+\/[^/]+$/.test(pathname)) {
        return "/signal/:runId/:signalName";
    }
    if (/^\/v1\/runs\/[^/]+$/.test(pathname))
        return "/v1/runs/:runId";
    return pathname;
}
/**
 * @param {number} statusCode
 * @returns {string}
 */
function statusClass(statusCode) {
    const normalized = Number.isFinite(statusCode) && statusCode > 0 ? statusCode : 500;
    return `${Math.floor(normalized / 100)}xx`;
}
/**
 * @param {string} method
 * @param {string} pathname
 * @param {number} statusCode
 * @param {number} durationMs
 */
function recordHttpRequestMetrics(method, pathname, statusCode, durationMs) {
    const tags = {
        method: method.toUpperCase(),
        route: normalizeHttpMetricRoute(pathname),
        status_code: String(statusCode),
        status_class: statusClass(statusCode),
    };
    return Effect.all([
        Metric.increment(taggedMetric(httpRequests, tags)),
        Metric.update(taggedMetric(httpRequestDuration, tags), durationMs),
    ], { discard: true });
}
/**
 * @param {string} method
 * @param {string} pathname
 * @param {number} statusCode
 * @param {number} durationMs
 */
async function recordHttpRequestMetricsSafely(method, pathname, statusCode, durationMs) {
    try {
        await runPromise(recordHttpRequestMetrics(method, pathname, statusCode, durationMs));
    }
    catch (error) {
        logWarning("failed to record server http metrics", {
            method: method.toUpperCase(),
            pathname,
            statusCode,
            error: error instanceof Error ? error.message : String(error),
        }, "server:metrics");
    }
}
/**
 * @param {IncomingMessage} req
 * @param {string} [authToken]
 */
function assertAuth(req, authToken) {
    if (!authToken)
        return;
    const header = req.headers["authorization"] ??
        req.headers["Authorization"] ??
        req.headers["x-smithers-key"];
    const value = Array.isArray(header) ? header[0] : header;
    const token = value?.startsWith("Bearer ") ? value.slice(7) : value;
    if (!token || token !== authToken) {
        throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid authorization token");
    }
}
/**
 * @param {string} workflowPath
 * @param {string} [rootDir]
 * @returns {string}
 */
function resolveWorkflowPath(workflowPath, rootDir) {
    const base = rootDir ? resolve(rootDir) : process.cwd();
    const resolved = resolve(base, workflowPath);
    if (rootDir) {
        const root = resolve(rootDir);
        const rootPrefix = root.endsWith(sep) ? root : root + sep;
        if (resolved !== root && !resolved.startsWith(rootPrefix)) {
            throw new HttpError(400, "WORKFLOW_PATH_OUTSIDE_ROOT", "Workflow path must be within server root directory");
        }
    }
    return resolved;
}
/**
 * @param {unknown} db
 * @returns {string | undefined}
 */
function getDbIdentity(db) {
    if (!db || typeof db !== "object") return undefined;
    const client = /** @type {{ $client?: unknown }} */ (db).$client;
    if (!client || typeof client !== "object")
        return undefined;
    const c = /** @type {Record<string, unknown>} */ (client);
    if (typeof c.filename === "string")
        return c.filename;
    if (typeof c.name === "string")
        return c.name;
    if (typeof c.dbname === "string")
        return c.dbname;
    return undefined;
}
/**
 * @param {unknown | null} serverDb
 * @param {unknown} workflowDb
 * @returns {boolean}
 */
function isSameDb(serverDb, workflowDb) {
    if (!serverDb)
        return false;
    if (serverDb === workflowDb)
        return true;
    const serverId = getDbIdentity(serverDb);
    const workflowId = getDbIdentity(workflowDb);
    return Boolean(serverId && workflowId && serverId === workflowId);
}
/**
 * @param {SmithersDb | null} adapter
 * @param {string} runId
 * @param {string} workflowName
 * @param {string} workflowPath
 * @param {string} configJson
 */
function buildMirrorOnProgress(adapter, runId, workflowName, workflowPath, configJson) {
    if (!adapter)
        return undefined;
    let runInserted = false;
    const ensureRun = async () => {
        if (runInserted)
            return;
        await adapter.insertRun({
            runId,
            workflowName,
            workflowPath,
            workflowHash: null,
            status: "running",
            createdAtMs: nowMs(),
            startedAtMs: nowMs(),
            finishedAtMs: null,
            heartbeatAtMs: eventLoopNow(),
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
            errorJson: null,
            configJson,
        });
        runInserted = true;
    };
    /**
   * @param {SmithersEvent} event
   */
    const mirrorEventEffect = (event) => Effect.gen(function* () {
        yield* Effect.tryPromise({
            try: () => ensureRun(),
            catch: (cause) => toSmithersError(cause, "ensure mirrored run"),
        });
        yield* adapter.insertEventWithNextSeq({
            runId,
            timestampMs: event.timestampMs,
            type: event.type,
            payloadJson: JSON.stringify(event),
        });
        switch (event.type) {
            case "RunStarted":
                yield* adapter.updateRun(runId, {
                    status: "running",
                    startedAtMs: event.timestampMs,
                    heartbeatAtMs: event.timestampMs,
                    cancelRequestedAtMs: null,
                });
                break;
            case "RunStatusChanged":
                yield* adapter.updateRun(runId, { status: event.status });
                break;
            case "RunContinuedAsNew":
                yield* adapter.updateRun(runId, {
                    status: "continued",
                    finishedAtMs: event.timestampMs,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                });
                break;
            case "RunFinished":
                yield* adapter.updateRun(runId, {
                    status: "finished",
                    finishedAtMs: event.timestampMs,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                });
                break;
            case "RunFailed":
                yield* adapter.updateRun(runId, {
                    status: "failed",
                    finishedAtMs: event.timestampMs,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    errorJson: JSON.stringify(errorToJson(event.error)),
                });
                break;
            case "RunCancelled":
                yield* adapter.updateRun(runId, {
                    status: "cancelled",
                    finishedAtMs: event.timestampMs,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                });
                break;
            case "NodePending":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "pending",
                    lastAttempt: null,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeWaitingApproval":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "waiting-approval",
                    lastAttempt: null,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeWaitingTimer":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "waiting-timer",
                    lastAttempt: null,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeStarted":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "in-progress",
                    lastAttempt: event.attempt,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeFinished":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "finished",
                    lastAttempt: event.attempt,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeFailed":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "failed",
                    lastAttempt: event.attempt,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeCancelled":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "cancelled",
                    lastAttempt: event.attempt ?? null,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeSkipped":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "skipped",
                    lastAttempt: null,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
            case "NodeRetrying":
                yield* adapter.insertNode({
                    runId: event.runId,
                    nodeId: event.nodeId,
                    iteration: event.iteration,
                    state: "in-progress",
                    lastAttempt: event.attempt,
                    updatedAtMs: event.timestampMs,
                    outputTable: "",
                    label: null,
                });
                break;
        }
    }).pipe(Effect.annotateLogs({
        runId,
        workflowName,
        workflowPath,
        eventType: event.type,
    }), Effect.withLogSpan("server:mirror-event"));
    return (event) => {
        void runPromise(mirrorEventEffect(event)).catch((err) => {
            logError("mirror event persistence failed", {
                runId,
                workflowPath,
                eventType: event.type,
                error: err instanceof Error ? err.message : String(err),
            }, "server:mirror-event");
        });
    };
}
function eventLoopNow() {
    return nowMs();
}
/**
 * @param {ServerOptions} [opts]
 */
function startServerInternal(opts = {}) {
    const port = opts.port ?? 7331;
    const serverDb = opts.db ?? null;
    const authToken = opts.authToken ?? process.env.SMITHERS_API_KEY;
    const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const rootDir = opts.rootDir ? resolve(opts.rootDir) : undefined;
    const allowNetwork = Boolean(opts.allowNetwork);
    if (serverDb) {
        ensureSmithersTables(serverDb);
    }
    const serverAdapter = serverDb ? new SmithersDb(serverDb) : null;
    logInfo("starting smithers server", {
        port,
        rootDir: rootDir ?? null,
        allowNetwork,
        hasServerDb: Boolean(serverDb),
    }, "server:start");
    const server = createServer(async (req, res) => {
        const requestStart = performance.now();
        const requestMethod = req.method ?? "GET";
        let requestPathname = (req.url ?? "/").split("?")[0] ?? "/";
        try {
            assertAuth(req, authToken);
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            const method = requestMethod;
            requestPathname = url.pathname;
            if (method === "GET" && url.pathname === "/metrics") {
                return sendText(res, 200, renderPrometheusMetrics(), prometheusContentType);
            }
            /**
       * @param {string} runId
       * @returns {SmithersDb | null}
       */
            function adapterForRun(runId) {
                if (serverAdapter) {
                    const record = runs.get(runId);
                    if (record) {
                        return new SmithersDb(record.workflow.db);
                    }
                    return serverAdapter;
                }
                const record = runs.get(runId);
                if (!record)
                    return null;
                return new SmithersDb(record.workflow.db);
            }
            if (method === "POST" && url.pathname === "/v1/runs") {
                const body = await readBody(req, maxBodyBytes, DEFAULT_MAX_BODY_JSON_DEPTH);
                if (!body?.workflowPath || typeof body.workflowPath !== "string") {
                    throw new HttpError(400, "INVALID_REQUEST", "workflowPath must be a string");
                }
                if (body.input !== undefined &&
                    (body.input === null ||
                        typeof body.input !== "object" ||
                        Array.isArray(body.input))) {
                    throw new HttpError(400, "INVALID_REQUEST", "input must be a JSON object");
                }
                if (body.config?.maxConcurrency !== undefined) {
                    const mc = Number(body.config.maxConcurrency);
                    if (!Number.isFinite(mc) || mc <= 0) {
                        throw new HttpError(400, "INVALID_REQUEST", "config.maxConcurrency must be a positive number");
                    }
                }
                const workflowPath = resolveWorkflowPath(body.workflowPath, rootDir);
                const workflow = await runPromise(loadWorkflowEffect(workflowPath));
                ensureSmithersTables(workflow.db);
                const sameDb = isSameDb(serverDb, workflow.db);
                const abort = new AbortController();
                if (body.resume && !body.runId) {
                    throw new HttpError(400, "RUN_ID_REQUIRED", "runId is required when resume is true");
                }
                const runId = body.runId ?? crypto.randomUUID();
                const adapter = new SmithersDb(workflow.db);
                const existing = await adapter.getRun(runId);
                if (body.resume && existing && isRunHeartbeatFresh(existing)) {
                    return sendJson(res, 200, { runId, status: "running" });
                }
                if (existing && !body.resume) {
                    throw new HttpError(409, "RUN_ALREADY_EXISTS", "Run id already exists");
                }
                if (body.resume && !existing) {
                    throw new HttpError(404, "RUN_NOT_FOUND", "Run id does not exist");
                }
                const mirrorAdapter = serverAdapter && !sameDb ? serverAdapter : null;
                const effectiveRoot = rootDir ?? dirname(workflowPath);
                const workflowName = basename(workflowPath, ".tsx");
                const mirrorOnProgress = buildMirrorOnProgress(mirrorAdapter, runId, workflowName, workflowPath, JSON.stringify({
                    maxConcurrency: body.config?.maxConcurrency ?? null,
                    rootDir: effectiveRoot,
                    allowNetwork,
                }));
                const record = {
                    workflow,
                    abort,
                    workflowPath,
                    cleanupTimer: null,
                };
                runs.set(runId, record);
                logInfo("accepted run request", {
                    runId,
                    workflowPath,
                    resume: Boolean(body.resume),
                    sameDb,
                }, "server:run");
                Effect.runPromise(runWorkflow(workflow, {
                    runId,
                    input: body.input ?? {},
                    resume: body.resume ?? false,
                    maxConcurrency: body.config?.maxConcurrency,
                    signal: abort.signal,
                    workflowPath,
                    rootDir: effectiveRoot,
                    allowNetwork,
                    onProgress: mirrorOnProgress,
                }))
                    .then((result) => {
                    finalizeRunRecord(result.runId, result.status, Boolean(serverDb));
                })
                    .catch((err) => {
                    logError("server run execution failed", {
                        runId,
                        workflowPath,
                        error: err instanceof Error ? err.message : String(err),
                    }, "server:run");
                    clearRunCleanupTimer(runs.get(runId));
                    runs.delete(runId);
                });
                sendJson(res, 200, { runId });
                return;
            }
            const resumeMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/resume$/);
            if (method === "POST" && resumeMatch) {
                const runId = resumeMatch[1];
                const body = await readBody(req, maxBodyBytes, DEFAULT_MAX_BODY_JSON_DEPTH);
                if (!body?.workflowPath || typeof body.workflowPath !== "string") {
                    throw new HttpError(400, "INVALID_REQUEST", "workflowPath must be a string");
                }
                if (body.input !== undefined &&
                    (body.input === null ||
                        typeof body.input !== "object" ||
                        Array.isArray(body.input))) {
                    throw new HttpError(400, "INVALID_REQUEST", "input must be a JSON object");
                }
                if (body.config?.maxConcurrency !== undefined) {
                    const mc = Number(body.config.maxConcurrency);
                    if (!Number.isFinite(mc) || mc <= 0) {
                        throw new HttpError(400, "INVALID_REQUEST", "config.maxConcurrency must be a positive number");
                    }
                }
                const workflowPath = resolveWorkflowPath(body.workflowPath, rootDir);
                const workflow = await runPromise(loadWorkflowEffect(workflowPath));
                ensureSmithersTables(workflow.db);
                const sameDb = isSameDb(serverDb, workflow.db);
                const adapter = new SmithersDb(workflow.db);
                const existing = await adapter.getRun(runId);
                if (!existing) {
                    throw new HttpError(404, "RUN_NOT_FOUND", "Run id does not exist");
                }
                if (isRunHeartbeatFresh(existing)) {
                    return sendJson(res, 200, { runId, status: "running" });
                }
                const abort = new AbortController();
                const record = {
                    workflow,
                    abort,
                    workflowPath,
                    cleanupTimer: null,
                };
                runs.set(runId, record);
                logInfo("accepted run resume request", {
                    runId,
                    workflowPath,
                    sameDb,
                }, "server:resume");
                const mirrorAdapter = serverAdapter && !sameDb ? serverAdapter : null;
                const effectiveRoot = rootDir ?? dirname(workflowPath);
                const workflowName = basename(workflowPath, ".tsx");
                const mirrorOnProgress = buildMirrorOnProgress(mirrorAdapter, runId, workflowName, workflowPath, JSON.stringify({
                    maxConcurrency: body.config?.maxConcurrency ?? null,
                    rootDir: effectiveRoot,
                    allowNetwork,
                }));
                Effect.runPromise(runWorkflow(workflow, {
                    runId,
                    input: body.input ?? {},
                    resume: true,
                    maxConcurrency: body.config?.maxConcurrency,
                    signal: abort.signal,
                    workflowPath,
                    rootDir: effectiveRoot,
                    allowNetwork,
                    onProgress: mirrorOnProgress,
                }))
                    .then((result) => {
                    finalizeRunRecord(runId, result.status, Boolean(serverDb));
                })
                    .catch((err) => {
                    logError("server resume execution failed", {
                        runId,
                        workflowPath,
                        error: err instanceof Error ? err.message : String(err),
                    }, "server:resume");
                    clearRunCleanupTimer(runs.get(runId));
                    runs.delete(runId);
                });
                sendJson(res, 200, { runId });
                return;
            }
            const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
            if (method === "POST" && cancelMatch) {
                const runId = cancelMatch[1];
                const adapter = adapterForRun(runId);
                const record = runs.get(runId);
                if (!adapter) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const run = await adapter.getRun(runId);
                if (!run) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                if (run.status === "waiting-approval" || run.status === "waiting-timer") {
                    const cancelledAtMs = nowMs();
                    const cancelEvent = {
                        type: "RunCancelled",
                        runId,
                        timestampMs: cancelledAtMs,
                    };
                    if (run.status === "waiting-timer") {
                        const nodes = await adapter.listNodes(runId);
                        for (const node of nodes.filter((entry) => entry.state === "waiting-timer")) {
                            const attempts = await runPromise(adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0));
                            const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer");
                            if (waitingAttempt) {
                                await adapter.updateAttempt(runId, node.nodeId, node.iteration ?? 0, waitingAttempt.attempt, { state: "cancelled", finishedAtMs: cancelledAtMs });
                                await adapter.insertNode({
                                    runId,
                                    nodeId: node.nodeId,
                                    iteration: node.iteration ?? 0,
                                    state: "cancelled",
                                    lastAttempt: waitingAttempt.attempt,
                                    updatedAtMs: cancelledAtMs,
                                    outputTable: node.outputTable ?? "",
                                    label: node.label ?? null,
                                });
                                const timerCancelledEvent = {
                                    type: "TimerCancelled",
                                    runId,
                                    timerId: node.nodeId,
                                    timestampMs: cancelledAtMs,
                                };
                                await adapter.insertEventWithNextSeq({
                                    runId,
                                    timestampMs: cancelledAtMs,
                                    type: "TimerCancelled",
                                    payloadJson: JSON.stringify(timerCancelledEvent),
                                });
                                await runPromise(trackEvent(timerCancelledEvent));
                            }
                        }
                    }
                    logInfo("cancelling paused run", {
                        runId,
                        status: run.status,
                    }, "server:cancel");
                    await adapter.updateRun(runId, {
                        status: "cancelled",
                        finishedAtMs: cancelledAtMs,
                        heartbeatAtMs: null,
                        runtimeOwnerId: null,
                        cancelRequestedAtMs: null,
                    });
                    await adapter.insertEventWithNextSeq({
                        runId,
                        timestampMs: cancelledAtMs,
                        type: "RunCancelled",
                        payloadJson: JSON.stringify(cancelEvent),
                    });
                    await runPromise(trackEvent(cancelEvent));
                    return sendJson(res, 200, { runId });
                }
                if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
                    logWarning("cancel rejected for inactive run", {
                        runId,
                        status: run.status,
                        heartbeatAtMs: run.heartbeatAtMs ?? null,
                    }, "server:cancel");
                    return sendJson(res, 409, {
                        error: { code: "RUN_NOT_ACTIVE", message: "Run is not currently active" },
                    });
                }
                logInfo("cancelling active run", {
                    runId,
                    status: run.status,
                }, "server:cancel");
                await adapter.requestRunCancel(runId, nowMs());
                record?.abort.abort();
                return sendJson(res, 200, { runId });
            }
            const runEventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
            if (method === "GET" && runEventsMatch) {
                const runId = runEventsMatch[1];
                const adapter = adapterForRun(runId);
                if (!adapter) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const run = await adapter.getRun(runId);
                if (!run) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "X-Content-Type-Options": "nosniff",
                    "X-Accel-Buffering": "no",
                });
                res.write(`retry: 1000\n\n`);
                let closed = false;
                let lastSeq = parseOptionalInt(url.searchParams.get("afterSeq"), -1);
                logInfo("opened run event stream", {
                    runId,
                    afterSeq: lastSeq,
                }, "server:sse");
                let lastHeartbeat = Date.now();
                const poll = async () => {
                    if (closed || res.writableEnded)
                        return;
                    const events = await adapter.listEvents(runId, lastSeq, 200);
                    for (const ev of events) {
                        const seq = typeof ev.seq === "number" ? ev.seq : Number(ev.seq);
                        if (Number.isFinite(seq)) {
                            lastSeq = seq;
                        }
                        if (res.writableEnded)
                            break;
                        res.write(`event: smithers\n`);
                        res.write(`data: ${ev.payloadJson}\n\n`);
                    }
                    const now = Date.now();
                    if (now - lastHeartbeat >= DEFAULT_SSE_HEARTBEAT_MS &&
                        !res.writableEnded) {
                        res.write(`: keep-alive\n\n`);
                        lastHeartbeat = now;
                    }
                    const runRow = await adapter.getRun(runId);
                    if (runRow &&
                        ["finished", "failed", "cancelled", "continued"].includes(runRow.status) &&
                        events.length === 0) {
                        closed = true;
                        res.end();
                    }
                };
                req.on("close", () => {
                    closed = true;
                });
                (async () => {
                    try {
                        while (!closed && !res.writableEnded) {
                            await poll();
                            await runPromise(Effect.sleep(500));
                        }
                    }
                    catch {
                        closed = true;
                        if (!res.writableEnded) {
                            res.end();
                        }
                    }
                })();
                return;
            }
            const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
            if (method === "GET" && runMatch) {
                const runId = runMatch[1];
                const adapter = adapterForRun(runId);
                if (!adapter) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const run = await adapter.getRun(runId);
                if (!run) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const summary = await adapter.countNodesByState(runId);
                const runState = await computeRunStateFromRow(adapter, run).catch(() => undefined);
                return sendJson(res, 200, {
                    runId,
                    workflowName: run?.workflowName ?? "workflow",
                    status: run?.status ?? "unknown",
                    startedAtMs: run?.startedAtMs ?? null,
                    finishedAtMs: run?.finishedAtMs ?? null,
                    ...(runState ? { runState } : {}),
                    summary: summary.reduce((acc, row) => {
                        acc[row.state] = row.count;
                        return acc;
                    }, {}),
                });
            }
            const framesMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/frames$/);
            if (method === "GET" && framesMatch) {
                const runId = framesMatch[1];
                const adapter = adapterForRun(runId);
                if (!adapter) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const run = await adapter.getRun(runId);
                if (!run) {
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                }
                const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
                const after = url.searchParams.get("afterFrameNo");
                const afterFrameNo = after ? parseOptionalInt(after, -1) : undefined;
                const frames = await adapter.listFrames(runId, limit, afterFrameNo !== undefined && afterFrameNo >= 0
                    ? afterFrameNo
                    : undefined);
                return sendJson(res, 200, frames);
            }
            const approveMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/approve$/);
            if (method === "POST" && approveMatch) {
                const runId = approveMatch[1];
                const nodeId = approveMatch[2];
                const body = await readBody(req, maxBodyBytes, DEFAULT_MAX_BODY_JSON_DEPTH);
                const adapter = adapterForRun(runId);
                if (!adapter)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                const run = await adapter.getRun(runId);
                if (!run)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                await Effect.runPromise(approveNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy));
                return sendJson(res, 200, { runId });
            }
            const denyMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/deny$/);
            if (method === "POST" && denyMatch) {
                const runId = denyMatch[1];
                const nodeId = denyMatch[2];
                const body = await readBody(req, maxBodyBytes, DEFAULT_MAX_BODY_JSON_DEPTH);
                const adapter = adapterForRun(runId);
                if (!adapter)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                const run = await adapter.getRun(runId);
                if (!run)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                await Effect.runPromise(denyNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy));
                return sendJson(res, 200, { runId });
            }
            const signalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/signals\/([^/]+)$/) ??
                url.pathname.match(/^\/signal\/([^/]+)\/([^/]+)$/);
            if (method === "POST" && signalMatch) {
                const runId = signalMatch[1];
                const signalName = decodeURIComponent(signalMatch[2]);
                const body = await readBody(req, maxBodyBytes, DEFAULT_MAX_BODY_JSON_DEPTH);
                const adapter = adapterForRun(runId);
                if (!adapter)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                const run = await adapter.getRun(runId);
                if (!run)
                    return sendJson(res, 404, {
                        error: { code: "NOT_FOUND", message: "Run not found" },
                    });
                const delivered = await Effect.runPromise(signalRun(adapter, runId, signalName, body.data ?? {}, {
                    correlationId: typeof body.correlationId === "string"
                        ? body.correlationId
                        : undefined,
                    receivedBy: typeof body.receivedBy === "string" ? body.receivedBy : undefined,
                }));
                return sendJson(res, 200, delivered);
            }
            if (method === "GET" &&
                (url.pathname === "/v1/approval/list" ||
                    url.pathname === "/v1/approvals" ||
                    url.pathname === "/approval/list" ||
                    url.pathname === "/approvals")) {
                if (!serverAdapter) {
                    return sendJson(res, 400, {
                        error: {
                            code: "DB_NOT_CONFIGURED",
                            message: "Server DB not configured",
                        },
                    });
                }
                const approvals = await runPromise(Effect.gen(function* () {
                    const rows = yield* serverAdapter.listAllPendingApprovals();
                    const now = nowMs();
                    const mapped = rows.map((row) => {
                        const requestedAtMs = row.requestedAtMs ?? null;
                        return {
                            runId: row.runId,
                            nodeId: row.nodeId,
                            iteration: row.iteration ?? 0,
                            workflowName: row.workflowName ?? "workflow",
                            runStatus: row.runStatus ?? null,
                            label: row.nodeLabel ?? row.nodeId,
                            requestTitle: row.nodeLabel ?? row.nodeId,
                            requestSummary: row.note ?? null,
                            requestedAtMs,
                            waitingMs: typeof requestedAtMs === "number" && Number.isFinite(requestedAtMs)
                                ? Math.max(0, now - requestedAtMs)
                                : 0,
                            note: row.note ?? null,
                            decidedBy: row.decidedBy ?? null,
                        };
                    });
                    yield* Effect.logDebug("listed pending approvals").pipe(Effect.annotateLogs({ pendingCount: mapped.length }));
                    return mapped;
                }).pipe(Effect.withLogSpan("api:approvals:list")));
                return sendJson(res, 200, { approvals });
            }
            if (method === "GET" && url.pathname === "/v1/runs") {
                if (!serverAdapter) {
                    return sendJson(res, 400, {
                        error: {
                            code: "DB_NOT_CONFIGURED",
                            message: "Server DB not configured",
                        },
                    });
                }
                const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
                const status = url.searchParams.get("status") ?? undefined;
                const runs = await serverAdapter.listRuns(limit, status);
                return sendJson(res, 200, await Promise.all(runs.map((run) => withRunState(serverAdapter, run))));
            }
            sendJson(res, 404, {
                error: { code: "NOT_FOUND", message: "Route not found" },
            });
        }
        catch (err) {
            if (err instanceof HttpError) {
                sendJson(res, err.status, {
                    error: { code: err.code, message: err.message, details: err.details },
                });
                return;
            }
            sendJson(res, 500, {
                error: {
                    code: "SERVER_ERROR",
                    message: err?.message ?? "Unknown error",
                },
            });
        }
        finally {
            await recordHttpRequestMetricsSafely(requestMethod, requestPathname, res.statusCode || 500, performance.now() - requestStart);
        }
    });
    server.on("close", () => {
        logInfo("stopping smithers server", {
            activeRuns: runs.size,
        }, "server:stop");
        for (const [runId, record] of runs) {
            try {
                record.abort.abort();
            }
            catch { }
            clearRunCleanupTimer(record);
            runs.delete(runId);
        }
    });
    server.listen(port);
    return server;
}
/**
 * @param {ServerOptions} [opts]
 */
export function startServerEffect(opts = {}) {
    return Effect.sync(() => startServerInternal(opts)).pipe(Effect.annotateLogs({
        port: opts.port ?? 7331,
        rootDir: opts.rootDir ?? "",
        allowNetwork: Boolean(opts.allowNetwork),
    }), Effect.withLogSpan("server:start"));
}
/**
 * @param {ServerOptions} [opts]
 */
export function startServer(opts = {}) {
    return runSync(startServerEffect(opts));
}
