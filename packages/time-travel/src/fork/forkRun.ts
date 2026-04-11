import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { forkRunEffect } from "./forkRunEffect";
import type { ForkParams } from "../ForkParams";
import type { BranchInfo } from "../BranchInfo";
import type { Snapshot } from "../snapshot/Snapshot";

export function forkRun(
  adapter: SmithersDb,
  params: ForkParams,
): Promise<{ runId: string; branch: BranchInfo; snapshot: Snapshot }> {
  return runPromise(forkRunEffect(adapter, params));
}
