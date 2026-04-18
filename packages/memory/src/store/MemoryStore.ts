import type { Effect } from "effect";
import type { SmithersError } from "@smithers-orchestrator/errors";
import type { MemoryNamespace } from "../MemoryNamespace";
import type { MemoryFact } from "../MemoryFact";
import type { MemoryThread } from "../MemoryThread";
import type { MemoryMessage } from "../MemoryMessage";

export type MemoryStore = {
  getFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Promise<MemoryFact | undefined>;
  setFact: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
  ) => Promise<void>;
  deleteFact: (ns: MemoryNamespace, key: string) => Promise<void>;
  listFacts: (ns: MemoryNamespace) => Promise<MemoryFact[]>;
  createThread: (ns: MemoryNamespace, title?: string) => Promise<MemoryThread>;
  getThread: (threadId: string) => Promise<MemoryThread | undefined>;
  deleteThread: (threadId: string) => Promise<void>;
  saveMessage: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Promise<void>;
  listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage[]>;
  countMessages: (threadId: string) => Promise<number>;
  deleteExpiredFacts: () => Promise<number>;
  getFactEffect: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  setFactEffect: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
  ) => Effect.Effect<void, SmithersError>;
  deleteFactEffect: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<void, SmithersError>;
  listFactsEffect: (
    ns: MemoryNamespace,
  ) => Effect.Effect<MemoryFact[], SmithersError>;
  createThreadEffect: (
    ns: MemoryNamespace,
    title?: string,
  ) => Effect.Effect<MemoryThread, SmithersError>;
  getThreadEffect: (
    threadId: string,
  ) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  deleteThreadEffect: (
    threadId: string,
  ) => Effect.Effect<void, SmithersError>;
  saveMessageEffect: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Effect.Effect<void, SmithersError>;
  listMessagesEffect: (
    threadId: string,
    limit?: number,
  ) => Effect.Effect<MemoryMessage[], SmithersError>;
  countMessagesEffect: (
    threadId: string,
  ) => Effect.Effect<number, SmithersError>;
  deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
};
