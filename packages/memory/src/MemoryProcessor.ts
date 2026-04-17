import type { Effect } from "effect";
import type { SmithersError } from "@smithers/errors";
import type { MemoryStore } from "./store/MemoryStore";

export type MemoryProcessor = {
  name: string;
  process: (store: MemoryStore) => Promise<void>;
  processEffect: (store: MemoryStore) => Effect.Effect<void, SmithersError>;
};
