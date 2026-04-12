import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";
import { MemoryStoreService } from "./MemoryStoreService";
export declare const MemoryStoreLive: Layer.Layer<MemoryStoreService, never, BunSQLiteDatabase<any>>;
