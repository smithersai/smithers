/**
 * Disposal and failure translation for QuickJS's pending-job result.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { ExecutePendingJobsResult } from "quickjs-emscripten-core";
import * as ScriptRunner from "../../../../src/ScriptRunner.ts";
/**
 * Disposes a pending-job result and translates its live error handle before
 * disposal when execution failed.
 *
 * @private
 * @since 0.1.0
 */
export declare const check: (jobs: ExecutePendingJobsResult) => Effect.Effect<void, ScriptRunner.ScriptFailure>;
