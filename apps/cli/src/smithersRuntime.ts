import { Effect } from "effect";
export declare function runPromise<A, E, R>(effect: Effect.Effect<A, E, R>, options?: {
    signal?: AbortSignal;
}): Promise<A>;
export declare function runFork<A, E, R>(effect: Effect.Effect<A, E, R>): import("effect/Fiber").RuntimeFiber<A, E>;
export declare function runSync<A, E, R>(effect: Effect.Effect<A, E, R>): A;
