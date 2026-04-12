import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
import type { PiExtensionUiRequest } from "./PiExtensionUiRequest";
import type { PiExtensionUiResponse } from "./PiExtensionUiResponse";
type RunRpcCommandOptions = {
    cwd: string;
    env: Record<string, string>;
    prompt: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onJsonEvent?: (event: Record<string, unknown>) => Promise<void> | void;
    onExtensionUiRequest?: (request: PiExtensionUiRequest) => Promise<PiExtensionUiResponse | null> | PiExtensionUiResponse | null;
};
export declare function runRpcCommandEffect(command: string, args: string[], options: RunRpcCommandOptions): Effect.Effect<{
    text: string;
    output: unknown;
    stderr: string;
    exitCode: number | null;
    usage?: any;
}, SmithersError>;
export {};
