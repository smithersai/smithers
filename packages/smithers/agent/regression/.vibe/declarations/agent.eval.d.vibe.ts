import * as Effect from "effect/Effect";
import { Suite, type Runner as EvalRunner } from "../../../evals/src/index.ts";
import { Binding } from "../../../scorers/src/index.ts";
export { executor, target } from "../../agent.eval.vibe.platform.js";
/**
 * The suite's name, shared by the run, the baseline, and the report.
 *
 * @category models
 * @since 0.1.0
 */
export declare const name = "flows-agent";
/**
 * The cases, derived from the scenario table so a case and the run it names
 * cannot drift apart.
 *
 * @category models
 * @since 0.1.0
 */
export declare const cases: ReadonlyArray<Suite.Case>;
/**
 * Both scorers, bound to the one target every case executes.
 *
 * @category models
 * @since 0.1.0
 */
export declare const bindings: ReadonlyArray<Binding.Binding>;
/** Fixed-suite declaration for the public eval CLI. */
export declare const suite: Effect.Effect<Suite.Suite, import("@smthrs/evals/EvalError").EvalError, never>;
/**
 * The batch runner the evaluation runner scores through.
 *
 * `Runner.run` declares this service in its requirements, so a suite has to
 * supply one even when its scorers are pure and blocking. This one executes
 * each job in process and validates the result with the scorers package's own
 * `Scorer.validate`, which is what the store-backed `Scoring.runBatch` does minus the
 * store: nothing here writes a score anywhere, because a committed baseline is
 * where this suite's scores live.
 *
 * @category services
 * @since 0.1.0
 */
export declare const scoring: EvalRunner.ScoreBatchRunner;
declare const _default: {
    suite: Effect.Effect<Suite.Suite, import("@smthrs/evals/EvalError").EvalError, never>;
    executor: import("@smthrs/evals/CaseExecutor").Service;
};
export default _default;
