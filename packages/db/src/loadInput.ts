import { runPromise } from "@smithers/runtime/runtime";
import { loadInputEffect } from "./loadInputEffect";

export async function loadInput(db: any, inputTable: any, runId: string) {
  return runPromise(loadInputEffect(db, inputTable, runId));
}
