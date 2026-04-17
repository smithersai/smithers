import { Layer } from "effect";
import { MemoryStoreDb } from "./MemoryStoreDb.js";
import { MemoryStoreLive } from "./MemoryStoreLive.js";
import { MemoryStoreService } from "./MemoryStoreService.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {Layer.Layer<MemoryStoreService, never, never>}
 */
export function createMemoryStoreLayer(db) {
    return MemoryStoreLive.pipe(Layer.provide(Layer.succeed(MemoryStoreDb, db)));
}
