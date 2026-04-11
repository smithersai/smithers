import { AsyncLocalStorage } from "node:async_hooks";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

export type ToolContext = {
  db: SmithersDb;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  idempotencyKey?: string | null;
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  seq: number;
  emitEvent?: (event: SmithersEvent) => void | Promise<void>;
};

const storage = new AsyncLocalStorage<ToolContext>();

export function runWithToolContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getToolContext(): ToolContext | undefined {
  return storage.getStore();
}

export function getToolIdempotencyKey(ctx: ToolContext | undefined = getToolContext()) {
  if (!ctx) {
    return null;
  }
  if (typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.length > 0) {
    return ctx.idempotencyKey;
  }
  return `smithers:${ctx.runId}:${ctx.nodeId}:${ctx.iteration}`;
}

export function nextToolSeq(ctx: ToolContext): number {
  ctx.seq += 1;
  return ctx.seq;
}
