import { z } from "zod";
import { unwrapZodType } from "./unwrapZodType";
import { camelToSnake } from "./utils/camelToSnake";

/**
 * Determines the Zod base type name from a (possibly unwrapped) Zod type.
 */
function getZodBaseTypeName(zodType: any): string {
  return zodType._zod?.def?.type ?? "unknown";
}

/**
 * Generates a CREATE TABLE IF NOT EXISTS SQL statement from a Zod schema.
 * Used for runtime table creation without Drizzle migrations.
 */
export function zodToCreateTableSQL(
  tableName: string,
  schema: z.ZodObject<any>,
  opts?: { isInput?: boolean },
): string {
  const colDefs: string[] = opts?.isInput
    ? [`run_id TEXT NOT NULL PRIMARY KEY`]
    : [
        `run_id TEXT NOT NULL`,
        `node_id TEXT NOT NULL`,
        `iteration INTEGER NOT NULL DEFAULT 0`,
      ];

  const shape = schema.shape;
  for (const [key] of Object.entries(shape)) {
    const colName = camelToSnake(key);
    const baseType = unwrapZodType(shape[key]);
    const baseTypeName = getZodBaseTypeName(baseType);

    if (
      baseTypeName === "number" ||
      baseTypeName === "int" ||
      baseTypeName === "float" ||
      baseTypeName === "boolean"
    ) {
      colDefs.push(`"${colName}" INTEGER`);
    } else {
      colDefs.push(`"${colName}" TEXT`);
    }
  }

  if (!opts?.isInput) {
    colDefs.push(`PRIMARY KEY (run_id, node_id, iteration)`);
  }
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")})`;
}
