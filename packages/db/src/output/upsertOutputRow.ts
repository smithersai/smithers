import type { Table } from "drizzle-orm";
import { runPromise } from "@smithers/runtime/runtime";
import { upsertOutputRowEffect } from "./upsertOutputRowEffect";
import type { OutputKey } from "./OutputKey";

export async function upsertOutputRow(
  db: any,
  table: Table,
  key: OutputKey,
  payload: Record<string, unknown>,
) {
  await runPromise(upsertOutputRowEffect(db, table, key, payload));
}
