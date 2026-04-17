import { Context } from "effect";
/** @typedef {import("./MemoryServiceApi.ts").MemoryServiceApi} MemoryServiceApi */

const MemoryServiceBase =
  /** @type {Context.TagClass<MemoryService, "MemoryService", MemoryServiceApi>} */ (
    /** @type {unknown} */ (Context.Tag("MemoryService")())
  );

export class MemoryService extends MemoryServiceBase {
}
