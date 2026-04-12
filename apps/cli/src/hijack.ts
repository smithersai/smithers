import type { SmithersDb } from "@smithers/db/adapter";
export type NativeHijackEngine = "claude-code" | "codex" | "gemini" | "pi" | "kimi" | "forge" | "amp";
export type HijackCandidate = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string;
    messages?: unknown[];
    cwd: string;
};
export type HijackLaunchSpec = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
};
export declare function resolveHijackCandidate(adapter: SmithersDb, runId: string, target?: string): Promise<HijackCandidate | null>;
export declare function waitForHijackCandidate(adapter: SmithersDb, runId: string, options?: {
    target?: string;
    timeoutMs?: number;
}): Promise<HijackCandidate>;
export declare function buildHijackLaunchSpec(candidate: HijackCandidate): HijackLaunchSpec;
export declare function isNativeHijackCandidate(candidate: HijackCandidate): candidate is HijackCandidate & {
    mode: "native-cli";
    engine: NativeHijackEngine;
    resume: string;
};
export declare function launchHijackSession(spec: HijackLaunchSpec): Promise<number>;
