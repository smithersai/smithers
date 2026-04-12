import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { RunCommandResult } from "./RunCommandResult";
type RunCommandOptions = {
    cwd: string;
    env: Record<string, string>;
    input?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
};
export declare function runCommandEffect(command: string, args: string[], options: RunCommandOptions): Effect.Effect<RunCommandResult, SmithersError>;
export {};
