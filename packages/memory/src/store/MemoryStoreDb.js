import { Context } from "effect";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<any>} BunSQLiteDatabaseAny */

/** @type {Context.Tag<BunSQLiteDatabaseAny, BunSQLiteDatabaseAny>} */
export const MemoryStoreDb =
  Context.GenericTag("MemoryStoreDb");
