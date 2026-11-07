import * as Effect from "effect/Effect";
import { CaseExecutor } from "../evals/src/index.ts";
import * as Subject from "./subject.ts";
/**
 * The target every binding applies to.
 *
 * The evaluation runner scores an execution only when its `target` is the value
 * a binding was declared against, so one declaration here is what attaches both
 * scorers to every case.
 *
 * @category models
 * @since 0.1.0
 */
export declare const target: {
    capabilities: never[];
    name: string;
    description: string;
};
export interface Scenario {
    /** What the case measures, restated for the report and the README. */
    readonly summary: string;
    readonly run: () => Effect.Effect<Subject.Observation>;
    readonly expected: Subject.Observation;
}
export declare const scenarios: Readonly<Record<string, Scenario>>;
/**
 * The execution boundary: it runs the named scenario as a whole agent run.
 *
 * A crash inside a scenario becomes a typed executor failure rather than a
 * defect that kills the suite, so a broken subject is reported as a missing
 * observation instead of an unreadable stack.
 *
 * @category services
 * @since 0.1.0
 */
export declare const executor: CaseExecutor.Service;
