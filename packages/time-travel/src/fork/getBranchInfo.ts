import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { getBranchInfoEffect } from "./getBranchInfoEffect";
import type { BranchInfo } from "../BranchInfo";

export function getBranchInfo(
  adapter: SmithersDb,
  runId: string,
): Promise<BranchInfo | undefined> {
  return runPromise(getBranchInfoEffect(adapter, runId));
}
