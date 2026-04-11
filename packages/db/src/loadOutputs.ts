import type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
import { runPromise } from "@smithers/runtime/runtime";
import { loadOutputsEffect } from "./loadOutputsEffect";

export async function loadOutputs(
  db: any,
  schema: Record<string, any>,
  runId: string,
): Promise<OutputSnapshot> {
  return runPromise(loadOutputsEffect(db, schema, runId));
}
