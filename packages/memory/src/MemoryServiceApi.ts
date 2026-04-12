import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { MemoryNamespace } from "./MemoryNamespace";
import type { MemoryFact } from "./MemoryFact";
import type { MemoryThread } from "./MemoryThread";
import type { MemoryMessage } from "./MemoryMessage";
import type { MemoryStore } from "./store/MemoryStore";
export type MemoryServiceApi = {
    readonly getFact: (ns: MemoryNamespace, key: string) => Effect.Effect<MemoryFact | undefined, SmithersError>;
    readonly setFact: (ns: MemoryNamespace, key: string, value: unknown, ttlMs?: number) => Effect.Effect<void, SmithersError>;
    readonly deleteFact: (ns: MemoryNamespace, key: string) => Effect.Effect<void, SmithersError>;
    readonly listFacts: (ns: MemoryNamespace) => Effect.Effect<MemoryFact[], SmithersError>;
    readonly createThread: (ns: MemoryNamespace, title?: string) => Effect.Effect<MemoryThread, SmithersError>;
    readonly getThread: (threadId: string) => Effect.Effect<MemoryThread | undefined, SmithersError>;
    readonly deleteThread: (threadId: string) => Effect.Effect<void, SmithersError>;
    readonly saveMessage: (msg: Omit<MemoryMessage, "createdAtMs"> & {
        createdAtMs?: number;
    }) => Effect.Effect<void, SmithersError>;
    readonly listMessages: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage[], SmithersError>;
    readonly countMessages: (threadId: string) => Effect.Effect<number, SmithersError>;
    readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;
    readonly store: MemoryStore;
};
