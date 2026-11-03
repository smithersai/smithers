/** Offline seeded-review fixture suite for the fixed-suite CLI. */
import { CaseExecutor, Suite } from "@smthrs/evals";
import { Effect } from "effect";
export declare const suite: Effect.Effect<Suite.Suite, import("@smthrs/evals/EvalError").EvalError, never>;
export declare const executor: CaseExecutor.Service;
declare const _default: {
    suite: Effect.Effect<Suite.Suite, import("@smthrs/evals/EvalError").EvalError, never>;
    executor: CaseExecutor.Service;
};
export default _default;
