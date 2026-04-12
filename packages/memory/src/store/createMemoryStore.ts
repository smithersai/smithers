import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { MemoryStore } from "./MemoryStore";
export declare function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore;
