import { completedUsage } from "./completedUsage.ts";
import type { UsageSummary } from "./parseUsage.ts";

const MAX_FRAME_CHARS = 64 * 1024;
const MAX_JSON_CHARS = 1024 * 1024;

/** A single backpressured pipeline; only the current frame and usage survive reads. */
export function teeForMetering(
  upstream: Response,
  streaming: boolean,
  abort: AbortController,
): {
  passthrough: ReadableStream<Uint8Array>;
  collected: Promise<{ summary: UsageSummary | null; complete: boolean }>;
} {
  const decoder = new TextDecoder();
  const usage: UsageSummary = {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let pending = "";
  let discarding = false;
  let input = false;
  let output = false;
  let stopped = false;
  let invalid = false;
  const frame = (text: string) => {
    const lines = text.split(/\r?\n/);
    const event = lines
      .findLast((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    if (!["message_start", "message_delta", "message_stop", "error"].includes(event ?? "")) return;
    try {
      const payload = JSON.parse(
        lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      );
      if (payload.type !== event) {
        invalid = true;
        return;
      }
      if (event === "error") invalid = true;
      if (event === "message_stop") stopped = true;
      if (event === "message_start" && typeof payload.message?.model === "string") usage.model = payload.message.model;
      const counts = event === "message_start" ? payload.message?.usage : payload.usage;
      if (!counts) return;
      if (event === "message_start") input = typeof counts.input_tokens === "number";
      if (event === "message_delta") output = typeof counts.output_tokens === "number";
      for (const [source, target] of [
        ["input_tokens", "inputTokens"],
        ["output_tokens", "outputTokens"],
        ["cache_creation_input_tokens", "cacheCreationTokens"],
        ["cache_read_input_tokens", "cacheReadTokens"],
      ] as const) {
        if (typeof counts[source] === "number") usage[target] = counts[source];
      }
    } catch {
      invalid = true;
    }
  };
  const take = (text: string) => {
    if (!streaming) {
      if (pending.length + text.length > MAX_JSON_CHARS) {
        invalid = true;
        pending = "";
      } else if (!invalid) pending += text;
      return;
    }
    // Decode in bounded pieces too: a single upstream chunk can contain a huge
    // content frame. Keep a delimiter suffix while skipping oversized frames.
    pending += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /(?:\r?\n){2}/.exec(pending))) {
      if (!discarding) frame(pending.slice(0, boundary.index));
      pending = pending.slice(boundary.index + boundary[0].length);
      discarding = false;
    }
    if (pending.length > MAX_FRAME_CHARS) {
      // Oversized content is harmless to metering; oversized usage is ambiguous.
      if (!/^event: (?:content_block_\w+|ping)\r?\n/.test(pending)) invalid = true;
      discarding = true;
    }
    if (discarding) pending = pending.slice(-3);
  };
  let onAbort: () => void;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // A pipe abort otherwise waits for a write stalled on downstream
      // backpressure. Error the transform to unblock that write immediately.
      onAbort = () => controller.error(abort.signal.reason);
      abort.signal.addEventListener("abort", onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
    },
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
        take(decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true }));
      }
      controller.enqueue(chunk);
    },
    flush() {
      take(decoder.decode());
      if (streaming && !discarding && pending) frame(pending);
      if (streaming) pending = "";
    },
  });
  // pipeTo propagates downstream cancellation to the source. Its rejection also
  // aborts the fetch, and resolves metering with frames observed before failure.
  const collected = upstream
    .body!.pipeTo(transform.writable, { signal: abort.signal })
    .then(
      () => {
        const complete = streaming ? input && output && stopped && !invalid : !invalid;
        const summary = streaming ? (complete ? usage : null) : complete ? completedUsage(pending) : null;
        pending = "";
        return { summary, complete: complete && summary !== null };
      },
      (reason: unknown) => {
        abort.abort(reason);
        pending = "";
        return { summary: streaming && input && usage.model ? usage : null, complete: false };
      },
    )
    .finally(() => abort.signal.removeEventListener("abort", onAbort));
  return { passthrough: transform.readable, collected };
}
