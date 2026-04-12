import { Layer } from "effect";
import { MemoryStoreDb } from "./MemoryStoreDb.js";
import { MemoryStoreLive } from "./MemoryStoreLive.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<any>} db
 */
export function createMemoryStoreLayer(db) {
    return MemoryStoreLive.pipe(Layer.provide(Layer.succeed(MemoryStoreDb, db)));
}
