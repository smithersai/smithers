import { Context } from "effect";
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */

const MemoryStoreServiceBase =
  /** @type {Context.TagClass<MemoryStoreService, "MemoryStoreService", MemoryStore>} */ (
    /** @type {unknown} */ (Context.Tag("MemoryStoreService")())
  );

export class MemoryStoreService extends MemoryStoreServiceBase {
}
