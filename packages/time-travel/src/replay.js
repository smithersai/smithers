// @smithers-type-exports-begin
/** @typedef {import("./ReplayResult.ts").ReplayResult} ReplayResult */
// @smithers-type-exports-end

import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { replayFromCheckpoint as replayFromCheckpointEffect } from "./replayFromCheckpointEffect.js";
export { replayFromCheckpointEffect };
/**
 * @param {Parameters<typeof replayFromCheckpointEffect>} ...args
 */
export function replayFromCheckpoint(...args) {
    return Effect.runPromise(replayFromCheckpointEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
