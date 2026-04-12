import { Context, Effect, Layer } from "effect";
import { SandboxEntityExecutor } from "./effect/sandbox-entity";
import { type SmithersError } from "@smithers/errors/SmithersError";
export type SandboxRuntime = "bubblewrap" | "docker" | "codeplane";
export type SandboxTransportConfig = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime;
    rootDir: string;
    image?: string;
};
export type SandboxHandle = {
    runtime: SandboxRuntime;
    runId: string;
    sandboxId: string;
    sandboxRoot: string;
    requestPath: string;
    resultPath: string;
    containerId?: string;
    workspaceId?: string;
};
export type SandboxBundleResult = {
    bundlePath: string;
};
export type SandboxTransportService = {
    readonly create: (config: SandboxTransportConfig) => Effect.Effect<SandboxHandle, SmithersError>;
    readonly ship: (bundlePath: string, handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
    readonly execute: (command: string, handle: SandboxHandle) => Effect.Effect<{
        exitCode: number;
    }, SmithersError>;
    readonly collect: (handle: SandboxHandle) => Effect.Effect<SandboxBundleResult, SmithersError>;
    readonly cleanup: (handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
};
declare const SandboxTransport_base: Context.TagClass<SandboxTransport, "SandboxTransport", SandboxTransportService>;
export declare class SandboxTransport extends SandboxTransport_base {
}
export declare function makeSandboxTransportLayer<R, E>(executorLayer: Layer.Layer<SandboxEntityExecutor, E, R>): Layer.Layer<SandboxTransport, E, R>;
export declare function layerForSandboxRuntime(runtime: SandboxRuntime): Layer.Layer<SandboxTransport, never, never>;
export declare function resolveSandboxRuntime(requested: SandboxRuntime): SandboxRuntime;
export {};
