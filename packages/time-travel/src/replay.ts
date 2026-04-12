import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { replayFromCheckpoint as replayFromCheckpointEffect } from "./replayFromCheckpointEffect";

export type { ReplayResult } from "./ReplayResult";
export { replayFromCheckpointEffect };

export function replayFromCheckpoint(
  ...args: Parameters<typeof replayFromCheckpointEffect>
) {
  return Effect.runPromise(replayFromCheckpointEffect(...args).pipe(Effect.provide(BunContext.layer)));
}
