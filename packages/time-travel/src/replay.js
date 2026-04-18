// @smithers-type-exports-begin
/** @typedef {import("./ReplayResult.ts").ReplayResult} ReplayResult */
// @smithers-type-exports-end

import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { replayFromCheckpoint as replayFromCheckpointEffect } from "./replayFromCheckpointEffect.js";
export { replayFromCheckpointEffect };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ReplayParams.ts").ReplayParams} ReplayParams */

/**
 * Fork a run from a checkpoint and optionally restore the VCS working copy.
 *
 * @param {SmithersDb} adapter
 * @param {ReplayParams} params
 * @returns {Promise<ReplayResult>}
 */
export function replayFromCheckpoint(adapter, params) {
    return Effect.runPromise(replayFromCheckpointEffect(adapter, params).pipe(Effect.provide(BunContext.layer)));
}
