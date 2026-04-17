import type { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { SandboxTransportConfig } from "./SandboxTransportConfig.ts";
import type { SandboxHandle } from "./SandboxHandle.ts";
import type { SandboxBundleResult } from "./SandboxBundleResult.ts";

export type SandboxTransportService = {
    readonly create: (config: SandboxTransportConfig) => Effect.Effect<SandboxHandle, SmithersError>;
    readonly ship: (bundlePath: string, handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
    readonly execute: (command: string, handle: SandboxHandle) => Effect.Effect<{
        exitCode: number;
    }, SmithersError>;
    readonly collect: (handle: SandboxHandle) => Effect.Effect<SandboxBundleResult, SmithersError>;
    readonly cleanup: (handle: SandboxHandle) => Effect.Effect<void, SmithersError>;
};
