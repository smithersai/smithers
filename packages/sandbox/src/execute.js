import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Metric } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { trackEvent, sandboxTransportDurationMs } from "@smithers-orchestrator/observability/metrics";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { executeChildWorkflow } from "@smithers-orchestrator/engine/child-workflow";
import { validateSandboxBundle, writeSandboxBundle } from "./bundle.js";
import { SandboxTransport, layerForSandboxRuntime, resolveSandboxRuntime, } from "./transport.js";
/** @typedef {import("./ExecuteSandboxOptions.ts").ExecuteSandboxOptions} ExecuteSandboxOptions */
/** @typedef {import("./SandboxRuntime.ts").SandboxRuntime} SandboxRuntime */
/** @typedef {import("./SandboxHandle.ts").SandboxHandle} SandboxHandle */
/** @typedef {import("./SandboxTransportService.ts").SandboxTransportService} SandboxTransportService */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */

const DEFAULT_MAX_CONCURRENT_SANDBOXES = 10;
/**
 * @param {ConstructorParameters<typeof SmithersDb>[0]} db
 * @param {SmithersEvent} event
 * @returns {Promise<void>}
 */
async function emitSandboxEvent(db, event) {
    const adapter = new SmithersDb(db);
    await adapter.insertEventWithNextSeq({
        runId: event.runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
    });
    await Effect.runPromise(trackEvent(event));
}
/**
 * @param {string} path
 * @returns {Promise<number>}
 */
async function directorySize(path) {
    const info = await stat(path).catch(() => null);
    if (!info)
        return 0;
    if (info.isFile())
        return info.size;
    return 0;
}
/**
 * @template A
 * @param {SandboxRuntime} runtime
 * @param {Effect.Effect<A, SmithersError, SandboxTransport>} effect
 * @returns {Effect.Effect<A, SmithersError, never>}
 */
function runtimeServiceEffect(runtime, effect) {
    return effect.pipe(Effect.provide(layerForSandboxRuntime(runtime)));
}
/**
 * @template A
 * @param {SandboxRuntime} runtime
 * @param {Effect.Effect<A, SmithersError, SandboxTransport>} effect
 * @returns {Promise<A>}
 */
async function transportCall(runtime, effect) {
    const started = performance.now();
    const value = await Effect.runPromise(runtimeServiceEffect(runtime, effect));
    await Effect.runPromise(Metric.update(sandboxTransportDurationMs, performance.now() - started));
    return value;
}
/**
 * @template A
 * @param {(svc: SandboxTransportService) => Effect.Effect<A, SmithersError>} fn
 * @returns {Effect.Effect<A, SmithersError, SandboxTransport>}
 */
function sandboxTransport(fn) {
    return Effect.flatMap(SandboxTransport, fn);
}
/**
 * @param {SandboxHandle | null} handle
 * @param {string} sandboxId
 * @returns {SandboxHandle}
 */
function requireSandboxHandle(handle, sandboxId) {
    if (handle)
        return handle;
    throw new SmithersError("SANDBOX_EXECUTION_FAILED", `Sandbox ${sandboxId} did not initialize correctly.`, { sandboxId });
}
/**
 * @returns {number}
 */
function resolveMaxConcurrentSandboxes() {
    const raw = process.env.SMITHERS_MAX_CONCURRENT_SANDBOXES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_MAX_CONCURRENT_SANDBOXES;
    }
    return Math.floor(parsed);
}
/**
 * @param {unknown} status
 * @returns {boolean}
 */
function isSandboxActive(status) {
    if (typeof status !== "string")
        return false;
    return status !== "finished" && status !== "failed" && status !== "cancelled";
}
/**
 * @param {ExecuteSandboxOptions} options
 * @returns {Promise<unknown>}
 */
export async function executeSandbox(options) {
    const runtime = requireTaskRuntime();
    runtime.heartbeat({
        sandboxId: options.sandboxId,
        stage: "initializing",
        progress: 0,
    });
    const adapter = new SmithersDb(runtime.db);
    const requestedRuntime = options.runtime ?? "bubblewrap";
    const selectedRuntime = resolveSandboxRuntime(requestedRuntime);
    const createdAtMs = nowMs();
    const configJson = JSON.stringify({
        runtime: requestedRuntime,
        selectedRuntime,
        allowNetwork: options.allowNetwork,
        maxOutputBytes: options.maxOutputBytes,
        toolTimeoutMs: options.toolTimeoutMs,
        reviewDiffs: options.reviewDiffs ?? true,
        autoAcceptDiffs: Boolean(options.autoAcceptDiffs),
        ...options.config,
    });
    const sandboxRoot = join(options.rootDir, ".smithers", "sandboxes", runtime.runId, options.sandboxId);
    const requestBundlePath = join(sandboxRoot, "request-bundle");
    /**
   * @param {string} childRunId
   */
    const childLogPath = (childRunId) => join(options.rootDir, ".smithers", "executions", childRunId, "logs", "stream.ndjson");
    let handle = null;
    try {
        const existingSandboxes = await adapter.listSandboxes(runtime.runId);
        const activeSandboxCount = existingSandboxes.filter((row) => isSandboxActive(row?.status)).length;
        const maxConcurrent = resolveMaxConcurrentSandboxes();
        if (activeSandboxCount >= maxConcurrent) {
            throw new SmithersError("SANDBOX_EXECUTION_FAILED", `Sandbox concurrency limit reached for run ${runtime.runId} (${maxConcurrent}).`, {
                runId: runtime.runId,
                maxConcurrent,
                activeSandboxCount,
            });
        }
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: null,
            containerId: null,
            configJson,
            status: "pending",
            shippedAtMs: null,
            completedAtMs: null,
            bundlePath: null,
        });
        await emitSandboxEvent(runtime.db, {
            type: "SandboxCreated",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            configJson,
            timestampMs: createdAtMs,
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "created",
            progress: 10,
        });
        await mkdir(requestBundlePath, { recursive: true });
        await writeFile(join(requestBundlePath, "README.md"), JSON.stringify({
            status: "pending",
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            input: options.input ?? {},
        }, null, 2), "utf8");
        const transportConfig = {
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            rootDir: options.rootDir,
            image: options.config?.image ?? undefined,
        };
        handle = await transportCall(selectedRuntime, sandboxTransport((svc) => svc.create(transportConfig)));
        const sandboxHandle = requireSandboxHandle(handle, options.sandboxId);
        await transportCall(selectedRuntime, sandboxTransport((svc) => svc.ship(requestBundlePath, sandboxHandle)));
        const bundleSizeBytes = await directorySize(join(requestBundlePath, "README.md"));
        await emitSandboxEvent(runtime.db, {
            type: "SandboxShipped",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            bundleSizeBytes,
            timestampMs: nowMs(),
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "shipped",
            progress: 25,
        });
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: sandboxHandle.workspaceId ?? null,
            containerId: sandboxHandle.containerId ?? null,
            configJson,
            status: "shipped",
            shippedAtMs: nowMs(),
            completedAtMs: null,
            bundlePath: null,
        });
        await transportCall(selectedRuntime, sandboxTransport((svc) => svc.execute("smithers up bundle.tsx", sandboxHandle)));
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "executing",
            progress: 40,
        });
        const childStartedMs = performance.now();
        const child = await executeChildWorkflow(options.parentWorkflow, {
            workflow: options.workflow,
            input: options.input,
            parentRunId: runtime.runId,
            rootDir: options.rootDir,
            allowNetwork: options.allowNetwork,
            maxOutputBytes: options.maxOutputBytes,
            toolTimeoutMs: options.toolTimeoutMs,
            signal: runtime.signal,
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "child-finished",
            progress: 70,
            childRunId: child.runId,
            childStatus: child.status,
        });
        await emitSandboxEvent(runtime.db, {
            type: "SandboxHeartbeat",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            remoteRunId: child.runId,
            progress: 1,
            timestampMs: nowMs(),
        });
        await writeSandboxBundle({
            bundlePath: sandboxHandle.resultPath,
            output: child.output,
            status: child.status === "finished" ? "finished" : "failed",
            runId: child.runId,
            streamLogPath: childLogPath(child.runId),
        });
        const collected = await transportCall(selectedRuntime, sandboxTransport((svc) => svc.collect(sandboxHandle)));
        const validated = await validateSandboxBundle(collected.bundlePath);
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "bundle-collected",
            progress: 85,
            bundlePath: validated.bundlePath,
            patchCount: validated.patchFiles.length,
        });
        await emitSandboxEvent(runtime.db, {
            type: "SandboxBundleReceived",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            bundleSizeBytes: validated.bundleSizeBytes,
            patchCount: validated.patchFiles.length,
            hasOutputs: validated.manifest.outputs !== undefined,
            timestampMs: nowMs(),
        });
        const reviewDiffs = options.reviewDiffs ?? true;
        if (reviewDiffs && validated.patchFiles.length > 0) {
            await emitSandboxEvent(runtime.db, {
                type: "SandboxDiffReviewRequested",
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                patchCount: validated.patchFiles.length,
                totalDiffLines: 0,
                timestampMs: nowMs(),
            });
            if (!options.autoAcceptDiffs) {
                await emitSandboxEvent(runtime.db, {
                    type: "SandboxDiffRejected",
                    runId: runtime.runId,
                    sandboxId: options.sandboxId,
                    reason: "Diff review approval is required before applying sandbox patches.",
                    timestampMs: nowMs(),
                });
                throw new SmithersError("INVALID_INPUT", "Sandbox produced patches that require review approval.", {
                    sandboxId: options.sandboxId,
                    patchCount: validated.patchFiles.length,
                });
            }
            await emitSandboxEvent(runtime.db, {
                type: "SandboxDiffAccepted",
                runId: runtime.runId,
                sandboxId: options.sandboxId,
                patchCount: validated.patchFiles.length,
                timestampMs: nowMs(),
            });
        }
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: child.runId,
            workspaceId: sandboxHandle.workspaceId ?? null,
            containerId: sandboxHandle.containerId ?? null,
            configJson,
            status: validated.manifest.status,
            shippedAtMs: createdAtMs,
            completedAtMs: nowMs(),
            bundlePath: validated.bundlePath,
        });
        await emitSandboxEvent(runtime.db, {
            type: "SandboxCompleted",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            remoteRunId: child.runId,
            runtime: selectedRuntime,
            status: validated.manifest.status,
            durationMs: performance.now() - childStartedMs,
            timestampMs: nowMs(),
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "completed",
            progress: 100,
            status: validated.manifest.status,
        });
        return validated.manifest.outputs;
    }
    catch (error) {
        await adapter.upsertSandbox({
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            remoteRunId: null,
            workspaceId: handle?.workspaceId ?? null,
            containerId: handle?.containerId ?? null,
            configJson,
            status: "failed",
            shippedAtMs: createdAtMs,
            completedAtMs: nowMs(),
            bundlePath: handle?.resultPath ?? null,
        });
        await emitSandboxEvent(runtime.db, {
            type: "SandboxFailed",
            runId: runtime.runId,
            sandboxId: options.sandboxId,
            runtime: selectedRuntime,
            error: errorToJson(error),
            timestampMs: nowMs(),
        });
        runtime.heartbeat({
            sandboxId: options.sandboxId,
            stage: "failed",
            progress: 100,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    finally {
        if (handle) {
            await transportCall(selectedRuntime, sandboxTransport((svc) => svc.cleanup(handle))).catch(() => undefined);
        }
    }
}
