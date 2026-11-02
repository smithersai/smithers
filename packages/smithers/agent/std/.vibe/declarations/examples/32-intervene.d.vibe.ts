import { Action, Flow } from "@smthrs/flow";
import * as Intervene from "@smthrs/patterns/Intervene";
import * as StdError from "@smthrs/std/StdError";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
/** The rewrite an intervention is asked to perform. */
export declare const Job: Schema.Struct<{
    readonly path: Schema.String;
    readonly from: Schema.String;
    readonly to: Schema.String;
}>;
/** What the intervention reports when it is done. */
export declare const Report: Schema.Struct<{
    readonly path: Schema.String;
    readonly replacements: Schema.Number;
    readonly dryRun: Schema.Boolean;
}>;
export declare const ReadTarget: Flow.Flow<"read-target", Schema.Struct<{
    readonly phase: Schema.String;
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly content: Schema.String;
    readonly startLine: Schema.Number;
    readonly endLine: Schema.Number;
    readonly totalLines: Schema.Number;
    readonly truncated: Schema.Boolean;
    readonly notice: Schema.optional<Schema.String>;
}>, Schema.Never, Action.Requirement<"read-target">>;
/** Turns the job into the edit the apply step performs. This step writes nothing. */
export declare const ProposeEdit: Flow.Flow<"propose-edit", Schema.Struct<{
    readonly phase: Schema.String;
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
    readonly context: Schema.Struct<{
        readonly content: Schema.String;
        readonly startLine: Schema.Number;
        readonly endLine: Schema.Number;
        readonly totalLines: Schema.Number;
        readonly truncated: Schema.Boolean;
        readonly notice: Schema.optional<Schema.String>;
    }>;
}>, Schema.Struct<{
    readonly path: Schema.String;
    readonly oldString: Schema.optional<Schema.String>;
    readonly startLine: Schema.optional<Schema.Int>;
    readonly endLine: Schema.optional<Schema.Int>;
    readonly expect: Schema.optional<Schema.String>;
    readonly newString: Schema.String;
    readonly replaceAll: Schema.optional<Schema.Boolean>;
}>, Schema.Never, never>;
export declare const ApplyEdit: Flow.Flow<"apply-edit", Schema.Struct<{
    readonly phase: Schema.String;
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
    readonly proposal: Schema.Struct<{
        readonly path: Schema.String;
        readonly oldString: Schema.optional<Schema.String>;
        readonly startLine: Schema.optional<Schema.Int>;
        readonly endLine: Schema.optional<Schema.Int>;
        readonly expect: Schema.optional<Schema.String>;
        readonly newString: Schema.String;
        readonly replaceAll: Schema.optional<Schema.Boolean>;
    }>;
}>, Schema.Struct<{
    readonly path: Schema.String;
    readonly replacements: Schema.Number;
    readonly startLine: Schema.Number;
    readonly endLine: Schema.Number;
    readonly hunk: Schema.String;
    readonly errors: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly line: Schema.Number;
        readonly character: Schema.Number;
        readonly message: Schema.String;
    }>>>;
}>, Schema.Never, Action.Requirement<"apply-edit">>;
/** Summarizes the intervention. */
export declare const ReportEdit: Flow.Flow<"report-edit", Schema.Struct<{
    readonly phase: Schema.String;
    readonly input: Schema.Struct<{
        readonly path: Schema.String;
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
    readonly proposal: Schema.Struct<{
        readonly path: Schema.String;
        readonly oldString: Schema.optional<Schema.String>;
        readonly startLine: Schema.optional<Schema.Int>;
        readonly endLine: Schema.optional<Schema.Int>;
        readonly expect: Schema.optional<Schema.String>;
        readonly newString: Schema.String;
        readonly replaceAll: Schema.optional<Schema.Boolean>;
    }>;
    readonly applied: Schema.optional<Schema.Struct<{
        readonly path: Schema.String;
        readonly replacements: Schema.Number;
        readonly startLine: Schema.Number;
        readonly endLine: Schema.Number;
        readonly hunk: Schema.String;
        readonly errors: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly line: Schema.Number;
            readonly character: Schema.Number;
            readonly message: Schema.String;
        }>>>;
    }>>;
    readonly dryRun: Schema.Boolean;
}>, Schema.Struct<{
    readonly path: Schema.String;
    readonly replacements: Schema.Number;
    readonly dryRun: Schema.Boolean;
}>, Schema.Never, never>;
export declare const ApproveEdit: Flow.Flow<"approve-edit", Schema.Struct<{
    readonly input: Schema.Unknown;
    readonly reason: Schema.String;
    readonly scope: Schema.String;
}>, Schema.Literal<"approved">, Schema.Never, Action.Requirement<"approve-edit">>;
/** The gated intervention: read, propose, approve, apply, report. */
export declare const plan: Intervene.InterveneFlow<Action.Requirement<"read-target">>;
/** The same intervention as a dry run: the plan has no apply call in it. */
export declare const dryPlan: Intervene.InterveneFlow<Action.Requirement<"read-target">>;
/**
 * Everything an intervention can fail with. Naming the union keeps the failure
 * channel readable instead of widening it to `unknown`: `PlatformError` comes
 * from the temp directory and the read-back, `StdError` from `Read.run` and
 * `Edit.run`, and `SchemaError` from an approval that does not decode as
 * `"approved"`.
 */
export type Failure = PlatformError.PlatformError | StdError.StdError | Schema.SchemaError;
/**
 * Runs an intervention over a fresh temp directory and returns the report next
 * to the file's contents afterwards, so a caller can see whether the write
 * actually happened.
 */
export declare const intervene: (options: {
    readonly dryRun: boolean;
    readonly decision: string;
}) => Effect.Effect<{
    readonly report: typeof Report.Type;
    readonly content: string;
}, Failure, FileSystem.FileSystem>;
/**
 * Applies the rewrite with an approval that answers `"approved"`, on a real
 * Node filesystem.
 */
export declare const main: Effect.Effect<{
    readonly report: typeof Report.Type;
    readonly content: string;
}, Failure>;
