import { Effect } from "effect";
/** The expected failure a program fails with; a success or a defect fails the test. */
export declare function failureOf<E>(program: Effect.Effect<unknown, E>): Effect.Effect<E>;
