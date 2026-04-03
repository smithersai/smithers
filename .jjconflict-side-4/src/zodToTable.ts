import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { unwrapZodType } from "./unwrapZodType";
import { camelToSnake } from "./utils/camelToSnake";

/**
 * Determines the Zod base type name from a (possibly unwrapped) Zod type.
 */
function getZodBaseTypeName(zodType: any): string {
  // Zod v4 style
  if (zodType._zod?.def) {
    return zodType._zod.def.type ?? "unknown";
  }
  // Zod v3 fallback
  const typeName = zodType._def?.typeName;
  if (typeName === "ZodString") return "string";
  if (typeName === "ZodNumber") return "number";
  if (typeName === "ZodBoolean") return "boolean";
  if (typeName === "ZodArray") return "array";
  if (typeName === "ZodObject") return "object";
  if (typeName === "ZodEnum") return "enum";
  if (typeName === "ZodLiteral") return "literal";
  if (typeName === "ZodUnion") return "union";
  return typeName ?? "unknown";
}

/**
 * Generates a Drizzle sqliteTable from a Zod object schema.
 *
 * Each Zod field is mapped to a SQLite column:
 * - z.string() / z.enum() -> text column
 * - z.number() -> integer column
 * - z.boolean() -> integer column with boolean mode
 * - z.array() / z.object() / complex -> text column with json mode
 *
 * All tables include standard smithers key columns:
 * runId, nodeId, iteration with a composite primary key.
 */
export function zodToTable(tableName: string, schema: z.ZodObject<any>): any {
  const columns: Record<string, any> = {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
  };

  const shape = schema.shape;
  for (const [key, zodType] of Object.entries(shape)) {
    const colName = camelToSnake(key);
    const baseType = unwrapZodType(zodType);
    const baseTypeName = getZodBaseTypeName(baseType);

    if (
      baseTypeName === "number" ||
      baseTypeName === "int" ||
      baseTypeName === "float"
    ) {
      columns[key] = integer(colName);
    } else if (baseTypeName === "boolean") {
      columns[key] = integer(colName, { mode: "boolean" });
    } else if (
      baseTypeName === "string" ||
      baseTypeName === "enum" ||
      baseTypeName === "literal"
    ) {
      columns[key] = text(colName);
    } else {
      // arrays, objects, unions, and anything complex -> JSON text
      columns[key] = text(colName, { mode: "json" });
    }
  }

  return sqliteTable(tableName, columns, (t: any) => [
    primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
  ]);
}
