import { runPromise } from "@smithers/runtime/runtime";
import type { PiExtensionUiRequest } from "./PiExtensionUiRequest";
import type { PiExtensionUiResponse } from "./PiExtensionUiResponse";
import { runRpcCommandEffect } from "./runRpcCommandEffect";

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
  onExtensionUiRequest?: (request: PiExtensionUiRequest) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
};

export async function runRpcCommand(command: string, args: string[], options: RunRpcCommandOptions): Promise<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
   usage?: any;
 }> {
   return runPromise(runRpcCommandEffect(command, args, options));
}
