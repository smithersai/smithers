import * as _smithers_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import { SmithersWorkflow } from '@smithers-orchestrator/components/SmithersWorkflow';
import { ChildWorkflowDefinition } from '@smithers-orchestrator/engine/child-workflow';
import { Context, Effect, Layer } from 'effect';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

type SandboxBundleManifest$1 = {
    outputs: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    patches?: string[];
};

type ValidatedSandboxBundle$1 = {
    manifest: SandboxBundleManifest$1;
    bundleSizeBytes: number;
    patchFiles: string[];
    logsPath: string | null;
    bundlePath: string;
};

/**
 * @param {string} bundlePath
 * @returns {Promise<ValidatedSandboxBundle>}
 */
declare function validateSandboxBundle(bundlePath: string): Promise<ValidatedSandboxBundle>;
/**
 * @param {{ bundlePath: string; output: unknown; status: "finished" | "failed" | "cancelled"; runId?: string; streamLogPath?: string | null; patches?: Array<{ path: string; content: string }>; artifacts?: Array<{ path: string; content: string }>; }} params
 */
declare function writeSandboxBundle(params: {
    bundlePath: string;
    output: unknown;
    status: "finished" | "failed" | "cancelled";
    runId?: string;
    streamLogPath?: string | null;
    patches?: Array<{
        path: string;
        content: string;
    }>;
    artifacts?: Array<{
        path: string;
        content: string;
    }>;
}): Promise<void>;
/** @typedef {import("./SandboxBundleManifest.ts").SandboxBundleManifest} SandboxBundleManifest */
/** @typedef {import("./ValidatedSandboxBundle.ts").ValidatedSandboxBundle} ValidatedSandboxBundle */
declare const SANDBOX_MAX_BUNDLE_BYTES: number;
declare const SANDBOX_MAX_README_BYTES: number;
declare const SANDBOX_MAX_PATCH_FILES: 1000;
declare const SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH: 256;
declare const SANDBOX_BUNDLE_PATH_MAX_LENGTH: 1024;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH: 16;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH: 512;
declare const SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH: number;
type SandboxBundleManifest = SandboxBundleManifest$1;
type ValidatedSandboxBundle = ValidatedSandboxBundle$1;

type SandboxRuntime$1 = "bubblewrap" | "docker" | "codeplane";

type SandboxTransportConfig$1 = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime$1;
    rootDir: string;
    image?: string;
};

type SandboxHandle = {
    runtime: SandboxRuntime$1;
    runId: string;
    sandboxId: string;
    sandboxRoot: string;
    requestPath: string;
    resultPath: string;
    containerId?: string;
    workspaceId?: string;
};

type SandboxBundleResult$1 = {
    bundlePath: string;
};

type SandboxTransportService = {
    readonly create: (config: SandboxTransportConfig$1) => Effect.Effect<SandboxHandle, SmithersError>;
    readonly ship: (bundlePath: string, handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
    readonly execute: (command: string, handle: SandboxHandle) => Effect.Effect<{
        exitCode: number;
    }, SmithersError>;
    readonly collect: (handle: SandboxHandle) => Effect.Effect<SandboxBundleResult$1, SmithersError>;
    readonly cleanup: (handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
};

type ExecuteSandboxOptions$1 = {
    parentWorkflow?: SmithersWorkflow<unknown>;
    sandboxId: string;
    runtime?: SandboxRuntime$1;
    workflow: ChildWorkflowDefinition;
    input?: unknown;
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    config?: Record<string, unknown>;
};

/**
 * @param {ExecuteSandboxOptions} options
 * @returns {Promise<unknown>}
 */
declare function executeSandbox(options: ExecuteSandboxOptions): Promise<unknown>;
type ExecuteSandboxOptions = ExecuteSandboxOptions$1;
type SmithersEvent = _smithers_observability_SmithersEvent.SmithersEvent;

declare class SandboxEntityExecutor extends Context.TagClassShape<"SandboxEntityExecutor", SandboxTransportService> {
}

/**
 * @template R, E
 * @param {Layer.Layer<SandboxEntityExecutor, E, R>} executorLayer
 * @returns {Layer.Layer<SandboxTransport, E, R>}
 */
declare function makeSandboxTransportLayer<R, E>(executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>): Layer.Layer<SandboxTransport, E, R>;
/**
 * @param {SandboxRuntime} runtime
 */
declare function layerForSandboxRuntime(runtime: SandboxRuntime): Layer.Layer<SandboxTransport, never, never>;
/**
 * @param {SandboxRuntime} requested
 * @returns {SandboxRuntime}
 */
declare function resolveSandboxRuntime(requested: SandboxRuntime): SandboxRuntime;
declare class SandboxTransport extends Context.TagClassShape<"SandboxTransport", SandboxTransportService> {
}
type SandboxBundleResult = SandboxBundleResult$1;
type SandboxTransportConfig = SandboxTransportConfig$1;
type SandboxRuntime = SandboxRuntime$1;

export { type ExecuteSandboxOptions, SANDBOX_BUNDLE_OUTPUT_MAX_ARRAY_LENGTH, SANDBOX_BUNDLE_OUTPUT_MAX_DEPTH, SANDBOX_BUNDLE_OUTPUT_MAX_STRING_LENGTH, SANDBOX_BUNDLE_PATH_MAX_LENGTH, SANDBOX_BUNDLE_RUN_ID_MAX_LENGTH, SANDBOX_MAX_BUNDLE_BYTES, SANDBOX_MAX_PATCH_FILES, SANDBOX_MAX_README_BYTES, type SandboxBundleManifest, type SandboxBundleResult, SandboxTransport, type SandboxTransportConfig, type SmithersEvent, type ValidatedSandboxBundle, executeSandbox, layerForSandboxRuntime, makeSandboxTransportLayer, resolveSandboxRuntime, validateSandboxBundle, writeSandboxBundle };
