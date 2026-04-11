import type { z } from "zod";

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export type MemoryNamespaceKind = "workflow" | "agent" | "user" | "global";

export type MemoryNamespace = {
  kind: MemoryNamespaceKind;
  id: string;
};

export function namespaceToString(ns: MemoryNamespace): string {
  return `${ns.kind}:${ns.id}`;
}

export function parseNamespace(str: string): MemoryNamespace {
  const idx = str.indexOf(":");
  if (idx < 0) {
    return { kind: "global", id: str };
  }
  const kind = str.slice(0, idx) as MemoryNamespaceKind;
  const id = str.slice(idx + 1);
  if (!["workflow", "agent", "user", "global"].includes(kind)) {
    return { kind: "global", id: str };
  }
  return { kind, id };
}

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

export type WorkingMemoryConfig<T extends z.ZodObject<any> = z.ZodObject<any>> = {
  schema?: T;
  namespace: MemoryNamespace;
  ttlMs?: number;
};

// ---------------------------------------------------------------------------
// Semantic Recall
// ---------------------------------------------------------------------------

export type SemanticRecallConfig = {
  topK?: number;
  namespace?: MemoryNamespace;
  similarityThreshold?: number;
};

// ---------------------------------------------------------------------------
// Message History
// ---------------------------------------------------------------------------

export type MessageHistoryConfig = {
  lastMessages?: number;
  threadId?: string;
};

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export type MemoryProcessorConfig = {
  processors?: string[];
};

// ---------------------------------------------------------------------------
// Stored Types
// ---------------------------------------------------------------------------

export type MemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
  schemaSig?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  ttlMs?: number | null;
};

export type MemoryThread = {
  threadId: string;
  namespace: string;
  title?: string | null;
  metadataJson?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type MemoryMessage = {
  id: string;
  threadId: string;
  role: string;
  contentJson: string;
  runId?: string | null;
  nodeId?: string | null;
  createdAtMs: number;
};

// ---------------------------------------------------------------------------
// Task Memory Config (used in <Task memory={...}> prop)
// ---------------------------------------------------------------------------

export type TaskMemoryConfig = {
  recall?: {
    namespace?: MemoryNamespace;
    query?: string;
    topK?: number;
  };
  remember?: {
    namespace?: MemoryNamespace;
    key?: string;
  };
  threadId?: string;
};
