import type { Table } from "drizzle-orm";
import { runPromise } from "@smithers/runtime/runtime";
import { selectOutputRowEffect } from "./selectOutputRowEffect";
import type { OutputKey } from "./OutputKey";

export async function selectOutputRow<T>(
  db: any,
  table: Table,
  key: OutputKey,
): Promise<T | undefined> {
  return runPromise(selectOutputRowEffect<T>(db, table, key));
}
