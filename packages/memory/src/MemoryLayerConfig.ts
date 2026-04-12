import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export type MemoryLayerConfig = {
  db: BunSQLiteDatabase<any>;
};
