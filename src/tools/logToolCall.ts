import { Effect, Metric } from "effect";
import { nowMs } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import { errorToJson } from "../utils/errors";
import { getToolContext, nextToolSeq } from "./context";
import { runPromise } from "../effect/runtime";
import { toolDuration } from "../effect/metrics";

export function logToolCallEffect(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "success" | "error",
  error?: unknown,
  startedAtMs?: number,
) {
  const ctx = getToolContext();
  if (!ctx) return Effect.void;
  const seq = nextToolSeq(ctx);
  const started = startedAtMs ?? nowMs();
  const finished = nowMs();
  const durationMs = finished - started;
  const maxLogBytes = ctx.maxOutputBytes ?? 200_000;
  const inputJson = safeJson(input, maxLogBytes);
  const outputJson = safeJson(output, maxLogBytes);
  const errorJson = error ? safeJson(errorToJson(error), maxLogBytes) : null;
  return Metric.update(toolDuration, durationMs).pipe(
    Effect.andThen(
      ctx.db.insertToolCallEffect({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        iteration: ctx.iteration,
        attempt: ctx.attempt,
        seq,
        toolName,
        inputJson,
        outputJson,
        startedAtMs: started,
        finishedAtMs: finished,
        status,
        errorJson,
      }),
    ),
    Effect.annotateLogs({
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      iteration: ctx.iteration,
      attempt: ctx.attempt,
      toolName,
      toolStatus: status,
    }),
    Effect.withLogSpan(`tool:${toolName}:log`),
  );
}

export async function logToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "success" | "error",
  error?: unknown,
  startedAtMs?: number,
) {
  await runPromise(
    logToolCallEffect(toolName, input, output, status, error, startedAtMs),
  );
}

export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

export function safeJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return json;
  const preview = truncateToBytes(json, maxBytes);
  return JSON.stringify({
    truncated: true,
    bytes: Buffer.byteLength(json, "utf8"),
    preview,
  });
}
