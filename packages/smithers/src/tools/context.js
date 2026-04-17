import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithToolContext(ctx, fn) {
  return storage.run(ctx, fn);
}

export function getToolContext() {
  return storage.getStore();
}

export function getToolIdempotencyKey(ctx = getToolContext()) {
  if (!ctx) {
    return null;
  }
  if (typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.length > 0) {
    return ctx.idempotencyKey;
  }
  if (!ctx.runId || !ctx.nodeId) {
    return null;
  }
  return `smithers:${ctx.runId}:${ctx.nodeId}:${ctx.iteration ?? 0}`;
}

export function nextToolSeq(ctx) {
  ctx.seq = (ctx.seq ?? 0) + 1;
  return ctx.seq;
}
