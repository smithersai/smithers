import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";
export declare function createMemoryStoreLayer(db: BunSQLiteDatabase<any>): Layer.Layer<import("./MemoryStoreService").MemoryStoreService, never, never>;
