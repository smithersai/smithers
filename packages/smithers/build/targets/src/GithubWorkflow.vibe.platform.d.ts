import * as Schema from "effect/Schema";
/**
 * Maximum encoded workflow size accepted by the structural parser.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumWorkflowBytes: number;
/**
 * One step of a workflow job.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowStep {
    readonly name: string | undefined;
    /** The step's `id:`, which a later step's `steps.<id>` expression reads. */
    readonly id: string | undefined;
    readonly uses: string | undefined;
    readonly run: string | undefined;
    /** The declared run shell, or `undefined` for the GitHub runner default. */
    readonly shell: string | undefined;
    /** The raw `if:` expression, or `undefined` when the step declares none. */
    readonly condition: string | undefined;
    /** The raw `continue-on-error:` value, or `undefined` when unset. */
    readonly continueOnError: string | undefined;
}
/**
 * One job of a workflow.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowJob {
    readonly id: string;
    readonly name: string | undefined;
    readonly runsOn: string | undefined;
    /** A reusable workflow reference, for a job that delegates with `uses:`. */
    readonly uses: string | undefined;
    /** The raw `if:` expression, or `undefined` when the job declares none. */
    readonly condition: string | undefined;
    /** The raw `continue-on-error:` value, or `undefined` when unset. */
    readonly continueOnError: string | undefined;
    readonly steps: ReadonlyArray<WorkflowStep>;
}
/**
 * A parsed workflow file.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workflow {
    readonly name: string | undefined;
    readonly jobs: ReadonlyArray<WorkflowJob>;
}
/**
 * Why a workflow file was refused.
 *
 * `too_large` is a source over {@link maximumWorkflowBytes}; `invalid_yaml`
 * is a structural YAML error; `unsupported` is a construct the gate scanner
 * will not follow (an alias, a merge, an inherited `defaults:`); `duplicate`
 * is a repeated key, job id, or event; `missing` is an absent trigger, job,
 * runner, or step; `invalid_shape` is any other value of the wrong shape.
 *
 * @category models
 * @since 0.1.0
 */
export declare const WorkflowParseReason: Schema.Literals<readonly ["too_large", "invalid_yaml", "unsupported", "duplicate", "missing", "invalid_shape"]>;
/**
 * Why a workflow file was refused.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowParseReason = typeof WorkflowParseReason.Type;
declare const WorkflowParseError_base: Schema.Class<WorkflowParseError, Schema.TaggedStruct<"smithers-build/WorkflowParseError", {
    readonly line: Schema.Number;
    readonly reason: Schema.Literals<readonly ["too_large", "invalid_yaml", "unsupported", "duplicate", "missing", "invalid_shape"]>;
    readonly detail: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A workflow file could not be read as a GitHub Actions workflow.
 *
 * The message is `line {line}: {detail}`.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class WorkflowParseError extends WorkflowParseError_base {
    readonly name = "WorkflowParseError";
    get message(): string;
}
/** One mapping entry, with the source line of its key. */
export interface Entry {
    readonly key: string;
    readonly value: unknown;
    readonly line: number;
}
/**
 * Parses a GitHub Actions workflow.
 *
 * Structure comes from `yaml`; everything this function adds is the part a
 * general YAML decoder cannot supply. It refuses a workflow whose gates it
 * could not verify: an alias or a `<<` merge, an inherited `defaults:` shell,
 * a duplicate top-level key, job id, job field, or step field, a job with no
 * runner or no steps, a step declaring neither or both of `uses` and `run`,
 * and a workflow with no trigger. Every refusal names the source line.
 *
 * @category parsing
 * @since 0.1.0
 */
export declare const parseWorkflow: (source: string) => Workflow;
export {};
