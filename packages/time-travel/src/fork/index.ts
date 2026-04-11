import { Effect } from "effect";
import { forkRun as forkRunEffect } from "./forkRunEffect";
import { getBranchInfo as getBranchInfoEffect } from "./getBranchInfoEffect";
import { listBranches as listBranchesEffect } from "./listBranchesEffect";

export {
  forkRunEffect,
  getBranchInfoEffect,
  listBranchesEffect,
};

export function forkRun(...args: Parameters<typeof forkRunEffect>) {
  return Effect.runPromise(forkRunEffect(...args));
}

export function listBranches(
  ...args: Parameters<typeof listBranchesEffect>
) {
  return Effect.runPromise(listBranchesEffect(...args));
}

export function getBranchInfo(
  ...args: Parameters<typeof getBranchInfoEffect>
) {
  return Effect.runPromise(getBranchInfoEffect(...args));
}
