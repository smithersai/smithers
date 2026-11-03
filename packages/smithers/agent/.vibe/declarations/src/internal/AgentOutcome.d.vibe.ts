/**
 * The terminal outcome of a successfully drained agent stream.
 * @since 1.0.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
type Outcome = {
    readonly _tag: "Completed";
    readonly output: string;
    readonly value?: Schema.Json | undefined;
    readonly corrected: number;
} | {
    readonly _tag: "FramesExhausted";
    readonly frames: number;
    readonly corrected: number;
};
/**
 * Keep completion separate from the stream's successful transport exit.
 * @category destructors
 * @since 1.0.0
 */
export declare const agentOutcome: <E, R, E2, R2>(stream: Stream.Stream<AgentEvent.AgentEvent, E, R>, record: (event: AgentEvent.AgentEvent) => Effect.Effect<void, E2, R2>) => Effect.Effect<Outcome, E | E2, R | R2>;
export {};
