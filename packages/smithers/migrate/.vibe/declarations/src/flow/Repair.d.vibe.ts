/**
 * The repair step: one failing verification round, handed back with the
 * contract still in context.
 *
 * A separate action rather than a retry of {@link module:Transform} because the
 * two are asked different questions. Transform is given a unit and the mapping;
 * repair is given a unit, the mapping, and the exact output of the command that
 * refused the rewrite. Keeping them apart also keeps the journal readable: a
 * reader can see how many rounds a unit cost and what each one was told.
 *
 * The brief a repair round receives is re-captured, so the sources it reads are
 * the ones on disk after the previous round edited them, not the ones the unit
 * started with.
 *
 * @since 1.0.0-rc.0
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import * as Schema from "effect/Schema";
/**
 * The repair step: the unit, the round, and what failed.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export declare const action: AgentAction.AgentAction<"smithers/migrate-v1/Repair", Schema.Struct<{
    unit: Schema.Struct<{
        readonly id: Schema.String;
        readonly kind: Schema.Literals<readonly ["dependencies", "workflow", "integration", "project"]>;
        readonly root: Schema.String;
        readonly sources: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly text: Schema.String;
        }>>;
        readonly targets: Schema.$Array<Schema.String>;
        readonly constructs: Schema.$Array<Schema.Struct<{
            readonly file: Schema.String;
            readonly line: Schema.Number;
            readonly column: Schema.Number;
            readonly construct: Schema.String;
            readonly props: Schema.$Array<Schema.String>;
            readonly class: Schema.Literals<readonly ["automatic", "guided", "unsafe"]>;
        }>>;
        readonly mapping: Schema.$Array<Schema.Struct<{
            readonly construct: Schema.String;
            readonly target: Schema.NullOr<Schema.String>;
            readonly targetModule: Schema.NullOr<Schema.String>;
            readonly rule: Schema.String;
            readonly class: Schema.Literals<readonly ["automatic", "guided", "unsafe"]>;
            readonly snippet: Schema.optional<Schema.String>;
        }>>;
        readonly hints: Schema.$Array<Schema.Struct<{
            readonly kind: Schema.Literals<readonly ["zod", "prompt"]>;
            readonly file: Schema.String;
            readonly name: Schema.String;
            readonly captured: Schema.String;
            readonly translation: Schema.optional<Schema.String>;
            readonly note: Schema.optional<Schema.String>;
        }>>;
        readonly unsafe: Schema.$Array<Schema.String>;
        readonly operatorDecisions: Schema.$Array<Schema.String>;
        readonly runStatePaths: Schema.$Array<Schema.String>;
        readonly approvedPackages: Schema.$Array<Schema.String>;
        readonly commands: Schema.Struct<{
            readonly install: Schema.optional<Schema.Union<readonly [Schema.String, Schema.Struct<{
                readonly _tag: Schema.Literal<"argv">;
                readonly executable: Schema.String;
                readonly args: Schema.$Array<Schema.String>;
            }>]>>;
            readonly format: Schema.optional<Schema.Union<readonly [Schema.String, Schema.Struct<{
                readonly _tag: Schema.Literal<"argv">;
                readonly executable: Schema.String;
                readonly args: Schema.$Array<Schema.String>;
            }>]>>;
            readonly typecheck: Schema.$Array<Schema.Union<readonly [Schema.String, Schema.Struct<{
                readonly _tag: Schema.Literal<"argv">;
                readonly executable: Schema.String;
                readonly args: Schema.$Array<Schema.String>;
            }>]>>;
            readonly test: Schema.optional<Schema.Union<readonly [Schema.String, Schema.Struct<{
                readonly _tag: Schema.Literal<"argv">;
                readonly executable: Schema.String;
                readonly args: Schema.$Array<Schema.String>;
            }>]>>;
            readonly flowsDir: Schema.String;
        }>;
        readonly warnings: Schema.optional<Schema.$Array<Schema.String>>;
        readonly expectFlows: Schema.optional<Schema.Boolean>;
    }>;
    round: Schema.Int;
    failures: Schema.Struct<{
        readonly install: Schema.optional<Schema.Struct<{
            readonly command: Schema.String;
            readonly exitCode: Schema.Number;
            readonly durationMs: Schema.Number;
            readonly stdoutTail: Schema.String;
            readonly stderrTail: Schema.String;
            readonly skipped: Schema.optional<Schema.String>;
        }>>;
        readonly format: Schema.optional<Schema.Struct<{
            readonly command: Schema.String;
            readonly exitCode: Schema.Number;
            readonly durationMs: Schema.Number;
            readonly stdoutTail: Schema.String;
            readonly stderrTail: Schema.String;
            readonly skipped: Schema.optional<Schema.String>;
        }>>;
        readonly typecheck: Schema.$Array<Schema.Struct<{
            readonly command: Schema.String;
            readonly exitCode: Schema.Number;
            readonly durationMs: Schema.Number;
            readonly stdoutTail: Schema.String;
            readonly stderrTail: Schema.String;
            readonly skipped: Schema.optional<Schema.String>;
        }>>;
        readonly tests: Schema.optional<Schema.Struct<{
            readonly command: Schema.String;
            readonly exitCode: Schema.Number;
            readonly durationMs: Schema.Number;
            readonly stdoutTail: Schema.String;
            readonly stderrTail: Schema.String;
            readonly skipped: Schema.optional<Schema.String>;
        }>>;
        readonly discovery: Schema.optional<Schema.Struct<{
            readonly command: Schema.String;
            readonly exitCode: Schema.Number;
            readonly durationMs: Schema.Number;
            readonly stdoutTail: Schema.String;
            readonly stderrTail: Schema.String;
            readonly skipped: Schema.optional<Schema.String>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly unit: Schema.String;
    readonly changedFiles: Schema.$Array<Schema.String>;
    readonly decisions: Schema.$Array<Schema.Struct<{
        readonly construct: Schema.String;
        readonly choice: Schema.String;
        readonly reason: Schema.String;
        readonly file: Schema.String;
        readonly line: Schema.Number;
    }>>;
    readonly unresolved: Schema.$Array<Schema.Struct<{
        readonly construct: Schema.String;
        readonly reason: Schema.String;
        readonly file: Schema.String;
        readonly line: Schema.Number;
        readonly suggestion: Schema.String;
        readonly unit: Schema.optional<Schema.String>;
    }>>;
    readonly unsupported: Schema.$Array<Schema.Struct<{
        readonly construct: Schema.String;
        readonly reason: Schema.String;
        readonly file: Schema.String;
        readonly line: Schema.Number;
        readonly closest: Schema.String;
        readonly unit: Schema.optional<Schema.String>;
    }>>;
    readonly notes: Schema.String;
}>>;
/**
 * The repair step's implementation. It is the same agent loop, the same seat,
 * and the same host as the transform step.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: import("effect/Layer").Layer<import("@smthrs/flow/Action").Requirement<"smithers/migrate-v1/Repair">, never, import("@smthrs/agent/Agent").Agent | import("@smthrs/agent/Budget").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("@smthrs/agent/QuotaPolicy").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("@smthrs/agent/SeatResolver").SeatResolver | import("@smthrs/harness/Steering").Source>;
