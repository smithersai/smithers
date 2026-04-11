import type { Table } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

export function validateExistingOutput(
  table: Table,
  payload: unknown,
): {
  ok: boolean;
  data?: any;
  error?: z.ZodError;
} {
  const schema = createSelectSchema(table as any);
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}
