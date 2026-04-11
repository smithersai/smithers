import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { replayFromCheckpointEffect } from "./replayFromCheckpointEffect";
import type { ReplayParams } from "./ReplayParams";
import type { ReplayResult } from "./ReplayResult";

export function replayFromCheckpoint(
  adapter: SmithersDb,
  params: ReplayParams,
): Promise<ReplayResult> {
  return runPromise(replayFromCheckpointEffect(adapter, params));
}
