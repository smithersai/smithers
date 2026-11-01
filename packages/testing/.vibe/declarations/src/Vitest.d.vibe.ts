/**
 * Vitest adapter for scoped Effect test bodies.
 *
 * This is the sole module in `/testing` that imports a test runner, and
 * the runner boundary is the **only** sanctioned `AbortSignal` touch in the
 * package: Vitest cancellation is converted to fiber interruption at the edge
 * (`Fiber.interrupt`), never threaded through Effect code.
 *
 * Governing design: `packages/testing/docs/concepts/test-tiers.md`, "The runner
 * boundary".
 *
 * @since 0.0.0
 */
import * as EffectVitest from "@effect/vitest";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { assert, describe, expect, type TestOptions } from "vitest";
import { type Body } from "./internal/TestEffectRunner.ts";
/** @since 0.0.0 @category testing */
export { assert, describe, expect };
/**
 * The Effect-aware `it`, with `scoped` aliased onto `it.effect`.
 *
 * Built as a fresh callable rather than by writing into `@effect/vitest`'s own
 * export. `Object.assign(EffectVitest.it, ...)` mutated the peer dependency's
 * live module object, and because that module is externalized and shared
 * across every test file in a worker process, importing this module replaced
 * `it.scoped` for every other file in that worker with a registrar that has
 * different semantics. It also made `sideEffects: []` false for this package.
 *
 * @category testing
 * @since 0.0.0
 */
export declare const it: typeof EffectVitest.it & {
    readonly scoped: typeof EffectVitest.it.effect;
};
interface TestRegistration<R> {
    <A, E>(name: string, body: Body<A, E, R | Scope.Scope>, options?: number | TestOptions): void;
}
interface EffectTest<R> extends TestRegistration<R> {
    readonly skip: TestRegistration<R>;
    readonly only: TestRegistration<R>;
}
/**
 * The Effect-aware test registrars, each carrying the requirements `R` a
 * body may use: `effect` under the test clock and `live` under the real one.
 *
 * Every variant already wraps its body in `Effect.scoped`, so `scoped` is an
 * alias of `effect` retained because a scoped body reads better under that
 * name. It is not a third registrar, and the docstring here used to claim a
 * three-way distinction that does not exist.
 *
 * @category testing
 * @since 0.0.0
 */
export interface TestEffect<R> {
    readonly effect: EffectTest<R>;
    readonly live: EffectTest<R>;
    /** An alias of {@link TestEffect.effect}; every variant provides a scope. */
    readonly scoped: EffectTest<R>;
    readonly skip: TestRegistration<R>;
    readonly only: TestRegistration<R>;
}
/**
 * Builds a **fresh** environment from the supplied layer for every test case
 * and runs each body in its own Scope. Allocate mutable services during layer
 * acquisition (`Layer.sync` or `Layer.effect`) to isolate them between tests;
 * objects captured by `Layer.succeed` remain shared. `TestHost` and the
 * deterministic variant's `TestClock` allocate fresh state per build.
 * The deterministic variant includes
 * TestClock; `live` intentionally uses the supplied layer with only
 * TestConsole added.
 *
 * Runner cancellation is converted to fiber interruption at this boundary:
 * the body runs as a forked fiber and the Vitest `AbortSignal` triggers
 * `Fiber.interrupt`. The signal itself never crosses into Effect code.
 *
 * @since 0.0.0
 * @category testing
 */
export declare const testEffect: <R, E>(layer: Layer.Layer<R, E>) => TestEffect<R>;
