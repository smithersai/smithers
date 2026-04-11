import type { SmithersDb } from "@smithers/db/adapter";
import { runPromise } from "@smithers/runtime/runtime";
import { listBranchesEffect } from "./listBranchesEffect";
import type { BranchInfo } from "../BranchInfo";

export function listBranches(
  adapter: SmithersDb,
  parentRunId: string,
): Promise<BranchInfo[]> {
  return runPromise(listBranchesEffect(adapter, parentRunId));
}
