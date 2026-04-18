import { spawn } from "node:child_process";
import { Effect, Metric } from "effect";
import { NodeDiffCache, NodeDiffTooLargeError } from "@smithers-orchestrator/db/cache/nodeDiffCache";
import { computeDiffBundleBetweenRefs } from "@smithers-orchestrator/engine/effect/diff-bundle";
import { runPromise } from "../smithersRuntime.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/db/adapter").AttemptRow} AttemptRow */
/** @typedef {import("./GetNodeDiffRouteResult.js").GetNodeDiffRouteResult} GetNodeDiffRouteResult */
/** @typedef {import("./DiffSummary.js").DiffSummary} DiffSummary */
const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const ITERATION_MAX = 2_147_483_647;
const CACHE_ROW_GAUGE_EMIT_MS = 5 * 60 * 1000;
const nodeDiffRequestTotal = Metric.counter("smithers_node_diff_request_total");
const nodeDiffComputeMs = Metric.histogram("smithers_node_diff_compute_ms");
const nodeDiffBytes = Metric.histogram("smithers_node_diff_bytes");
const nodeDiffCacheTotal = Metric.counter("smithers_node_diff_cache_total");
const nodeDiffCacheRows = Metric.gauge("smithers_node_diff_cache_rows");
// The gauge is process-global because "total rows across the DB" is the
// metric the spec requires, and the periodic emitter should not be tied to
// per-request lifecycle.
let lastCacheRowGaugeEmitAtMs = 0;
let cacheRowGaugeInflight = null;
/**
 * @template M
 * @param {M} metric
 * @param {Record<string, string | number | null | undefined>} [labels]
 * @returns {M}
 */
function taggedMetric(metric, labels = {}) {
    let tagged = metric;
    for (const [key, value] of Object.entries(labels)) {
        if (value === undefined || value === null) {
            continue;
        }
        tagged = Metric.tagged(tagged, key, String(value));
    }
    return tagged;
}
/**
 * @param {() => Promise<void>} run
 */
async function swallow(run) {
    try {
        await run();
    }
    catch {
        // Observability never blocks the RPC path.
    }
}
class GetNodeDiffError extends Error {
    code;
    details;
    /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
    constructor(code, message, details) {
        super(message);
        this.name = "GetNodeDiffError";
        this.code = code;
        this.details = details;
    }
}
/**
 * @param {unknown} runId
 * @returns {string}
 */
function validateRunId(runId) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
        throw new GetNodeDiffError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    }
    return runId;
}
/**
 * @param {unknown} nodeId
 * @returns {string}
 */
function validateNodeId(nodeId) {
    if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
        throw new GetNodeDiffError("InvalidNodeId", "nodeId must match /^[a-zA-Z0-9:_-]{1,128}$/.");
    }
    return nodeId;
}
/**
 * @param {unknown} iteration
 * @returns {number}
 */
function validateIteration(iteration) {
    if (typeof iteration !== "number" ||
        !Number.isInteger(iteration) ||
        iteration < 0 ||
        iteration > ITERATION_MAX) {
        throw new GetNodeDiffError("InvalidIteration", "iteration must be an i32 non-negative integer.");
    }
    return iteration;
}
/**
 * @param {string} message
 */
function isWorkingTreeDirty(message) {
    return /working copy|dirty|conflict|cannot restore/i.test(message);
}
/**
 * @param {string | undefined} value
 */
function safeVcsMessage(value) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        return "VCS operation failed.";
    }
    return normalized.length > 512 ? `${normalized.slice(0, 512)}…` : normalized;
}
/**
 * @param {string} cwd
 * @param {string[]} args
 */
function runJj(cwd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn("jj", args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
            resolve({
                code: typeof code === "number" ? code : 1,
                stdout,
                stderr,
            });
        });
    });
}
/**
 * @param {string} pointer
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function resolveCommitPointer(pointer, cwd) {
    const res = await runJj(cwd, ["log", "-r", pointer, "--no-graph", "--template", "commit_id"]);
    if (res.code !== 0) {
        return null;
    }
    const commitId = res.stdout.trim();
    return commitId.length > 0 ? commitId : null;
}
/**
 * Pick the base ref for a target attempt's diff.
 *
 * Correctness: the base must be the end of the *previous* attempt of the
 * *same task* (same runId/nodeId/iteration/jjCwd). Earlier attempts of
 * unrelated tasks must never be considered; otherwise a retry on node B
 * could pick an attempt from node A as its base.
 *
 * Ordering uses `finishedAtMs` (the actual task end time). Ties fall back
 * to attempt number descending.
 *
 * @param {AttemptRow[]} attempts
 * @param {AttemptRow} targetAttempt
 * @param {string | null | undefined} runVcsRevision
 * @returns {string | null}
 */
function resolveBaseRef(attempts, targetAttempt, runVcsRevision) {
    const previousSameTask = attempts
        .filter((row) => row.nodeId === targetAttempt.nodeId &&
        row.iteration === targetAttempt.iteration &&
        row.jjCwd === targetAttempt.jjCwd &&
        row.attempt < targetAttempt.attempt &&
        typeof row.jjPointer === "string" &&
        row.jjPointer.length > 0 &&
        typeof row.finishedAtMs === "number")
        .sort((left, right) => {
        const leftFinished = Number(left.finishedAtMs ?? -1);
        const rightFinished = Number(right.finishedAtMs ?? -1);
        if (leftFinished !== rightFinished) {
            return rightFinished - leftFinished;
        }
        return right.attempt - left.attempt;
    })[0];
    if (previousSameTask?.jjPointer) {
        return previousSameTask.jjPointer;
    }
    // Fall back to the most recent attempt (any task) in the same checkout
    // that finished strictly before this attempt started. This captures
    // "the previous task in the run" when this is the first attempt of a
    // new node.
    const previousAny = attempts
        .filter((row) => row.jjCwd === targetAttempt.jjCwd &&
        !(row.nodeId === targetAttempt.nodeId && row.iteration === targetAttempt.iteration) &&
        typeof row.jjPointer === "string" &&
        row.jjPointer.length > 0 &&
        typeof row.finishedAtMs === "number" &&
        row.finishedAtMs <= targetAttempt.startedAtMs)
        .sort((left, right) => {
        const leftFinished = Number(left.finishedAtMs ?? -1);
        const rightFinished = Number(right.finishedAtMs ?? -1);
        if (leftFinished !== rightFinished) {
            return rightFinished - leftFinished;
        }
        return right.attempt - left.attempt;
    })[0];
    if (previousAny?.jjPointer) {
        return previousAny.jjPointer;
    }
    if (typeof runVcsRevision === "string" && runVcsRevision.length > 0) {
        return runVcsRevision;
    }
    return targetAttempt.jjPointer ?? null;
}
/**
 * Emit the cache-rows gauge at most every CACHE_ROW_GAUGE_EMIT_MS.
 * Total rows (no runId filter). Runs out-of-band so no request waits on it.
 *
 * @param {NodeDiffCache} cache
 * @param {(effect: Effect.Effect<void>) => Promise<unknown>} emitEffect
 * @param {() => number} nowMs
 */
function scheduleCacheRowGauge(cache, emitEffect, nowMs) {
    if (cacheRowGaugeInflight) {
        return;
    }
    if (nowMs() - lastCacheRowGaugeEmitAtMs < CACHE_ROW_GAUGE_EMIT_MS) {
        return;
    }
    lastCacheRowGaugeEmitAtMs = nowMs();
    cacheRowGaugeInflight = (async () => {
        try {
            const rows = await cache.countRows();
            await emitEffect(Metric.set(nodeDiffCacheRows, rows));
        }
        catch {
            // Gauge is best-effort.
        }
        finally {
            cacheRowGaugeInflight = null;
        }
    })();
}
/**
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ adapter: SmithersDb } | null>;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 *   computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<import("@smithers-orchestrator/engine/effect/DiffBundle").DiffBundle>;
 *   computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<import("@smithers-orchestrator/engine/effect/DiffBundle").DiffBundle>;
 *   getCurrentPointerImpl?: (cwd: string) => Promise<string | null>;
 *   resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
 *   restorePointerImpl?: (pointer: string, cwd: string) => Promise<{ success: boolean; error?: string }>;
 *   nowMs?: () => number;
 *   stat?: boolean;
 * }} opts
 * @returns {Promise<GetNodeDiffRouteResult>}
 */
export async function getNodeDiffRoute({
    runId: rawRunId,
    nodeId: rawNodeId,
    iteration: rawIteration,
    resolveRun,
    emitEffect = (effect) => runPromise(effect),
    computeDiffBundleImpl,
    computeDiffBundleBetweenRefsImpl,
    getCurrentPointerImpl,
    resolveCommitPointerImpl = resolveCommitPointer,
    restorePointerImpl,
    nowMs = () => Date.now(),
    // stat: true → return summary only ({ files, filesChanged, added,
    // removed }). Bypasses the cache and the full-bundle JSON size guard
    // so very large diffs still return a summary. The full diff text is
    // never serialized.
    stat = false,
}) {
    // Prefer the explicit between-refs impl. If a caller only passed
    // computeDiffBundleImpl (the legacy working-tree variant, or a mock in
    // tests), adapt it: pass (baseRef, cwd, seq) and ignore targetRef since
    // the mock's return value is decoupled from the actual VCS state.
    const effectiveComputeBetween = computeDiffBundleBetweenRefsImpl
        ?? (computeDiffBundleImpl
            ? async (baseRef, _targetRef, cwd, seq) => computeDiffBundleImpl(baseRef, cwd, seq)
            : computeDiffBundleBetweenRefs);
    let resultLabel = "error";
    let cacheResultLabel = "miss";
    let sizeBytes = 0;
    let computeDurationMs = 0;
    const rootSpanAttrs = {
        runId: typeof rawRunId === "string" ? rawRunId : "",
        nodeId: typeof rawNodeId === "string" ? rawNodeId : "",
        iteration: typeof rawIteration === "number" ? rawIteration : -1,
        cacheResult: "unknown",
    };
    const finalize = async () => {
        await swallow(() => emitEffect(Effect.all([
            Metric.increment(taggedMetric(nodeDiffRequestTotal, { result: resultLabel })),
            Effect.logInfo("getNodeDiff request handled").pipe(Effect.annotateLogs({
                ...rootSpanAttrs,
                result: resultLabel,
                cacheResult: rootSpanAttrs.cacheResult,
                sizeBytes,
                computeDurationMs,
            })),
        ], { discard: true })));
    };
    try {
        const runId = validateRunId(rawRunId);
        const nodeId = validateNodeId(rawNodeId);
        const iteration = validateIteration(rawIteration);
        rootSpanAttrs.runId = runId;
        rootSpanAttrs.nodeId = nodeId;
        rootSpanAttrs.iteration = iteration;
        const resolved = await resolveRun(runId);
        if (!resolved) {
            throw new GetNodeDiffError("RunNotFound", `Run not found: ${runId}`);
        }
        const adapter = resolved.adapter;
        const node = await adapter.getNode(runId, nodeId, iteration);
        if (!node) {
            throw new GetNodeDiffError("NodeNotFound", `Node not found: ${runId}/${nodeId}/${iteration}`);
        }
        const attemptsForNode = await adapter.listAttempts(runId, nodeId, iteration);
        const latestAttempt = attemptsForNode[0];
        if (!latestAttempt) {
            throw new GetNodeDiffError("AttemptNotFound", `Attempt not found for ${runId}/${nodeId}/${iteration}`);
        }
        if (latestAttempt.state === "in-progress") {
            throw new GetNodeDiffError("AttemptNotFinished", "Attempt is still running.");
        }
        const run = await adapter.getRun(runId);
        // Blocker #8: Explicit branch on VCS type. Only jj is supported today.
        // Git-backed runs typically lack `jjPointer` on their attempts, so
        // without this check the handler returns a confusing
        // AttemptNotFinished. Return a clear VcsError instead.
        //
        // Decision note: git-backed diff support is deferred. Once the engine
        // can resolve start/end commit hashes for a task under git, extend
        // this to branch on vcsType === "git" and compute via
        // computeDiffBundleBetweenRefsImpl (which is read-only and
        // already-VCS-agnostic at the `git diff` layer).
        if (run && typeof run.vcsType === "string" && run.vcsType !== "jj") {
            throw new GetNodeDiffError("VcsError", `Unsupported VCS type: ${run.vcsType}. Only jj-backed runs are supported.`);
        }
        if (typeof latestAttempt.jjPointer !== "string" || latestAttempt.jjPointer.length === 0) {
            throw new GetNodeDiffError("AttemptNotFinished", "Attempt has no finished jj pointer.");
        }
        if (typeof latestAttempt.jjCwd !== "string" || latestAttempt.jjCwd.length === 0) {
            throw new GetNodeDiffError("VcsError", "Attempt did not record a jj working directory.");
        }
        const attemptsForRun = await adapter.listAttemptsForRun(runId);
        const baseRefCandidate = resolveBaseRef(attemptsForRun, latestAttempt, run?.vcsRevision);
        if (!baseRefCandidate) {
            throw new GetNodeDiffError("AttemptNotFound", "Could not resolve a base jj pointer for this attempt.");
        }
        const cacheLogger = {
            warn: (message, details) => {
                void swallow(() => emitEffect(Effect.logWarning(message).pipe(Effect.annotateLogs({
                    runId,
                    nodeId,
                    iteration,
                    ...details,
                }))));
            },
        };
        const cache = new NodeDiffCache(adapter, cacheLogger);
        /**
         * @param {"hit" | "miss"} cacheResult
         * @param {number} bytes
         */
        const recordCacheResult = async (cacheResult, bytes) => {
            sizeBytes = bytes;
            resultLabel = cacheResult;
            cacheResultLabel = cacheResult;
            rootSpanAttrs.cacheResult = cacheResult;
            await swallow(() => emitEffect(Effect.all([
                Metric.increment(taggedMetric(nodeDiffCacheTotal, { result: cacheResult })),
                Metric.update(nodeDiffBytes, bytes),
            ], { discard: true })));
        };
        // Blocker #7: gauge is total rows (no runId filter), emitted
        // out-of-band at most every CACHE_ROW_GAUGE_EMIT_MS. Does not block
        // this request.
        scheduleCacheRowGauge(cache, emitEffect, nowMs);
        let key = { runId, nodeId, iteration, baseRef: baseRefCandidate };
        // Finding #5: stat-only path bypasses cache and the JSON size cap so
        // large diffs (>50MB) can still return a summary. Summaries are
        // cheap to recompute and never hit the payload limit.
        if (stat) {
            const targetPointer = (await resolveCommitPointerImpl(latestAttempt.jjPointer, latestAttempt.jjCwd)) ?? latestAttempt.jjPointer;
            const resolvedBaseRefStat = (await resolveCommitPointerImpl(baseRefCandidate, latestAttempt.jjCwd)) ?? baseRefCandidate;
            const computeStartedAt = nowMs();
            const bundle = await effectiveComputeBetween(resolvedBaseRefStat, targetPointer, latestAttempt.jjCwd, latestAttempt.attempt);
            computeDurationMs = Math.max(0, nowMs() - computeStartedAt);
            const summary = summarizeBundle(bundle);
            await swallow(() => emitEffect(Effect.all([
                Metric.update(nodeDiffComputeMs, computeDurationMs),
            ], { discard: true })));
            resultLabel = "ok";
            rootSpanAttrs.cacheResult = "bypass";
            await finalize();
            return {
                ok: true,
                payload: {
                    seq: latestAttempt.attempt ?? 1,
                    baseRef: resolvedBaseRefStat,
                    summary,
                },
            };
        }
        // Blocker #5: explicit span for cache lookup.
        const directHit = await emitEffectSpan(emitEffect, "db.nodeDiffs.get", rootSpanAttrs, () => cache.get(key));
        if (directHit) {
            await recordCacheResult("hit", directHit.sizeBytes);
            await finalize();
            return { ok: true, payload: directHit.bundle };
        }
        const resolvedBaseRef = (await resolveCommitPointerImpl(baseRefCandidate, latestAttempt.jjCwd)) ?? baseRefCandidate;
        if (resolvedBaseRef !== baseRefCandidate) {
            key = { ...key, baseRef: resolvedBaseRef };
            const resolvedHit = await emitEffectSpan(emitEffect, "db.nodeDiffs.get", rootSpanAttrs, () => cache.get(key));
            if (resolvedHit) {
                await recordCacheResult("hit", resolvedHit.sizeBytes);
                await finalize();
                return { ok: true, payload: resolvedHit.bundle };
            }
        }
        const result = await cache.getOrCompute(key, async () => {
            // Blocker #2 & #3: read-only compute. No restore of working
            // copy, no chance of interfering with concurrent runs or
            // leaking untracked files. Resolve both endpoints to immutable
            // commit IDs and diff directly.
            const targetPointer = (await resolveCommitPointerImpl(latestAttempt.jjPointer, latestAttempt.jjCwd)) ?? latestAttempt.jjPointer;
            const computeStartedAt = nowMs();
            try {
                // Blocker #5: vcs.computeDiffBundle span with fileCount/bytes.
                const bundle = await effectiveComputeBetween(key.baseRef, targetPointer, latestAttempt.jjCwd, latestAttempt.attempt);
                computeDurationMs = Math.max(0, nowMs() - computeStartedAt);
                const fileCount = Array.isArray(bundle?.patches) ? bundle.patches.length : 0;
                const bytes = Buffer.byteLength(JSON.stringify(bundle ?? {}), "utf8");
                // Blocker #6: only the cold compute time feeds the compute
                // histogram, regardless of cache hits and validation errors.
                await swallow(() => emitEffect(Effect.all([
                    Metric.update(nodeDiffComputeMs, computeDurationMs),
                    Effect.logDebug("vcs.computeDiffBundle").pipe(Effect.annotateLogs({
                        ...rootSpanAttrs,
                        span: "vcs.computeDiffBundle",
                        fileCount,
                        bytes,
                        durationMs: computeDurationMs,
                    })),
                ], { discard: true })));
                return bundle;
            }
            catch (error) {
                computeDurationMs = Math.max(0, nowMs() - computeStartedAt);
                // Blocker #5: unrecoverable VCS errors log at error level
                // (no diff content).
                const message = error instanceof Error ? error.message : String(error);
                await swallow(() => emitEffect(Effect.logError("vcs.computeDiffBundle failed").pipe(Effect.annotateLogs({
                    ...rootSpanAttrs,
                    span: "vcs.computeDiffBundle",
                    error: safeVcsMessage(message),
                }))));
                throw error;
            }
        });
        // Blocker #5: db.nodeDiffs.upsert span log. The actual upsert
        // happens inside NodeDiffCache.getOrCompute; we emit a span marker
        // around the write here so traces show it.
        if (result.cacheResult === "miss") {
            await swallow(() => emitEffect(Effect.logDebug("db.nodeDiffs.upsert").pipe(Effect.annotateLogs({
                ...rootSpanAttrs,
                span: "db.nodeDiffs.upsert",
                sizeBytes: result.sizeBytes,
            }))));
        }
        await recordCacheResult(result.cacheResult, result.sizeBytes);
        await finalize();
        return { ok: true, payload: result.bundle };
    }
    catch (error) {
        if (error instanceof NodeDiffTooLargeError) {
            resultLabel = "error";
            sizeBytes = error.sizeBytes;
            await finalize();
            return {
                ok: false,
                error: {
                    code: "DiffTooLarge",
                    message: `${error.message} [truncated]`,
                },
            };
        }
        if (error instanceof GetNodeDiffError) {
            resultLabel = "error";
            await finalize();
            return {
                ok: false,
                error: {
                    code: error.code,
                    message: error.message,
                },
            };
        }
        const safeMessage = safeVcsMessage(error instanceof Error ? error.message : String(error));
        const code = isWorkingTreeDirty(safeMessage) ? "WorkingTreeDirty" : "VcsError";
        resultLabel = "error";
        // Blocker #5: unrecoverable errors log at error level.
        await swallow(() => emitEffect(Effect.logError("getNodeDiff failed").pipe(Effect.annotateLogs({
            ...rootSpanAttrs,
            errorCode: code,
            error: safeMessage,
        }))));
        await finalize();
        return {
            ok: false,
            error: {
                code,
                message: safeMessage,
            },
        };
    }
}
/**
 * Wrap a promise-returning function in a named log span so observability
 * backends see it as a child of the root span.
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
        const result = await run();
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
 * Compute a lightweight per-file / total summary of a DiffBundle without
 * retaining full patch text. Counts lines starting with "+"/"-" excluding
 * file headers ("+++"/"---").
 *
 * @param {{ patches?: Array<{ path: string; diff?: string }> }} bundle
 * @returns {DiffSummary}
 */
function summarizeBundle(bundle) {
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    const patches = Array.isArray(bundle?.patches) ? bundle.patches : [];
    for (const patch of patches) {
        let added = 0;
        let removed = 0;
        const text = typeof patch?.diff === "string" ? patch.diff : "";
        // Iterate lines without a huge split allocation for very large diffs.
        let cursor = 0;
        while (cursor < text.length) {
            const nl = text.indexOf("\n", cursor);
            const end = nl === -1 ? text.length : nl;
            const ch = text.charCodeAt(cursor);
            // Skip "+++ " / "--- " headers; count "+"/"-" content lines.
            if (ch === 43 /* + */ && !(text.charCodeAt(cursor + 1) === 43 && text.charCodeAt(cursor + 2) === 43)) {
                added++;
            }
            else if (ch === 45 /* - */ && !(text.charCodeAt(cursor + 1) === 45 && text.charCodeAt(cursor + 2) === 45)) {
                removed++;
            }
            cursor = end + 1;
        }
        totalAdded += added;
        totalRemoved += removed;
        files.push({ path: String(patch?.path ?? ""), added, removed });
    }
    return {
        filesChanged: files.length,
        added: totalAdded,
        removed: totalRemoved,
        files,
    };
}
export { RUN_ID_PATTERN, NODE_ID_PATTERN, ITERATION_MAX, summarizeBundle };
