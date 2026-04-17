import type { SandboxRuntime } from "./SandboxRuntime.ts";

export type SandboxTransportConfig = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime;
    rootDir: string;
    image?: string;
};
