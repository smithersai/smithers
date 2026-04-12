import type { AnyColumn, Table } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { createHash } from "node:crypto";

export function schemaSignature(table: Table): string {
  const cols = getTableColumns(table as any) as Record<string, AnyColumn>;
  const keys = Object.keys(cols).sort();
  const parts: string[] = [getTableName(table as any)];
  for (const key of keys) {
    const col: any = cols[key];
    const type =
      col?.columnType ?? col?.dataType ?? col?.getSQLType?.() ?? "unknown";
    const notNull = col?.notNull ? "1" : "0";
    const primary = col?.primary ? "1" : "0";
    parts.push(`${key}:${type}:${notNull}:${primary}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
