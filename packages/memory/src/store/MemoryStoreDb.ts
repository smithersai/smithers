import { Context } from "effect";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
export declare const MemoryStoreDb: Context.Tag<BunSQLiteDatabase<any>, BunSQLiteDatabase<any>>;
