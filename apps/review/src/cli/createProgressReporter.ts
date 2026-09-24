import { CurrentReviewFile } from "../workflow/currentReviewFile.ts";
/**
 * Live stderr progress for a review run.
 *
 * 0.x polled the engine's output tables for this. rc.0 has a push seam
 * instead: `@smthrs/agent/EventSink` hands a host every `AgentEvent` on its way
 * past, inside the frame that produced it. The reporter therefore counts turns
 * and settlements rather than reading rows, which also means it works before
 * any row has been written.
 *
 * `EventSink.emit` runs inside the engine's write transaction, so nothing here
 * waits: every method is a synchronous write to stderr.
 *
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent";
import * as EventSink from "@smthrs/agent/EventSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * A reporter: the layer to provide, and the counts it accumulated.
 *
 * @since 1.0.0
 * @category models
 */
export interface ProgressReporter {
  /** The `EventSink` layer that feeds this reporter. */
  readonly layer: Layer.Layer<EventSink.EventSink>;
  /** Model turns opened so far, by seat and file. */
  readonly turns: () => ReadonlyMap<string, number>;
  /** Prompt and completion tokens observed by this invocation. */
  readonly tokens: () => { readonly input: number; readonly output: number };
}

/**
 * Builds a progress reporter over a caller-supplied writer.
 *
 * The writer is a parameter so a test asserts on the lines rather than on
 * captured stderr.
 *
 * @since 1.0.0
 * @category constructors
 */
export function createProgressReporter(options: {
  write: (line: string) => void;
}): ProgressReporter {
  const turns = new Map<string, number>();
  let input = 0;
  let output = 0;

  const emit = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
    Effect.gen(function*() {
      const file = yield* CurrentReviewFile;
      switch (event._tag) {
        case "turn-opened": {
          const label = file ? `${event.seat} ${file}` : event.seat;
          const seen = (turns.get(label) ?? 0) + 1;
          turns.set(label, seen);
          options.write(`${label}: turn ${seen}`);
          return;
        }
        case "model-settled": {
          input += event.usage.inputTokens ?? 0;
          output += event.usage.outputTokens ?? 0;
          return;
        }
        case "model-retried": {
          options.write(`retrying the model call (attempt ${event.attempt}): ${event.code}`);
          return;
        }
        case "aborted": {
          options.write(`aborted: ${event.reason}`);
          return;
        }
        default:
          return;
      }
    });

  return {
    layer: EventSink.layer({ emit }),
    turns: () => turns,
    tokens: () => ({ input, output }),
  };
}
