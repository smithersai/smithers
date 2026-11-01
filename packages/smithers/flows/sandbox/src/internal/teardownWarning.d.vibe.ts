/**
 * Logs provider teardown failures without rendering vendor data.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts";
/**
 * Only adapter-selected fields reach the logger. In particular, neither the
 * error message nor its retained SDK cause is inspected or rendered.
 *
 * @category logging
 * @since 0.1.0
 */
export declare const warnTeardown: (provider: "vercel" | "daytona" | "cloudflare" | "aws" | "microsandbox", operation: "stop" | "delete" | "destroy" | "stopTasks" | "deregisterTaskDefinition" | "kill", error: ProviderError) => Effect.Effect<void>;
