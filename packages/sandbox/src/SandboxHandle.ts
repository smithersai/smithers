import type { SandboxRuntime } from "./SandboxRuntime.ts";

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
