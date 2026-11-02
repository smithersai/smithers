import { Schema } from "effect";
declare const EarlyFeedback_base: Schema.Class<EarlyFeedback, Schema.TaggedStruct<"coding/EarlyFeedback", {
    readonly result: Schema.Struct<{
        readonly status: Schema.Literals<readonly ["validated", "changes-requested"]>;
        readonly changes: Schema.$Array<Schema.Struct<{
            readonly implementation: Schema.Struct<{
                readonly change: Schema.String;
                readonly parent: Schema.Struct<{
                    readonly changeId: Schema.NonEmptyString;
                    readonly commitId: Schema.NonEmptyString;
                    readonly treeId: Schema.NonEmptyString;
                    readonly operationId: Schema.NonEmptyString;
                    readonly parentCommitIds: Schema.$Array<Schema.NonEmptyString>;
                }>;
                readonly atoms: Schema.$Array<Schema.Struct<{
                    readonly changeId: Schema.NonEmptyString;
                    readonly commitId: Schema.NonEmptyString;
                    readonly treeId: Schema.NonEmptyString;
                    readonly operationId: Schema.NonEmptyString;
                    readonly parentCommitIds: Schema.$Array<Schema.NonEmptyString>;
                }>>;
                readonly head: Schema.Struct<{
                    readonly changeId: Schema.NonEmptyString;
                    readonly commitId: Schema.NonEmptyString;
                    readonly treeId: Schema.NonEmptyString;
                    readonly operationId: Schema.NonEmptyString;
                    readonly parentCommitIds: Schema.$Array<Schema.NonEmptyString>;
                }>;
                readonly reads: Schema.$Array<Schema.NonEmptyString>;
                readonly writes: Schema.$Array<Schema.NonEmptyString>;
            }>;
            readonly receipts: Schema.$Array<Schema.Struct<{
                readonly checkId: Schema.String;
                readonly target: Schema.NonEmptyString;
                readonly tier: Schema.Literals<readonly ["fast", "slow", "delivery"]>;
                readonly change: Schema.String;
                readonly commitId: Schema.NonEmptyString;
                readonly treeId: Schema.NonEmptyString;
                readonly inputDigest: Schema.NonEmptyString;
                readonly status: Schema.Literals<readonly ["passed", "failed", "superseded"]>;
                readonly fault: Schema.optionalKey<Schema.Literals<readonly ["infra", "factory"]>>;
                readonly startedAt: Schema.optionalKey<Schema.Int>;
                readonly finishedAt: Schema.optionalKey<Schema.Int>;
                readonly evidence: Schema.String;
                readonly findings: Schema.$Array<Schema.Struct<{
                    readonly owner: Schema.String;
                    readonly message: Schema.NonEmptyString;
                    readonly sourceCommitId: Schema.NonEmptyString;
                    readonly output: Schema.optionalKey<Schema.NonEmptyString>;
                }>>;
            }>>;
        }>>;
        readonly findings: Schema.$Array<Schema.Struct<{
            readonly owner: Schema.String;
            readonly message: Schema.NonEmptyString;
            readonly sourceCommitId: Schema.NonEmptyString;
            readonly output: Schema.optionalKey<Schema.NonEmptyString>;
        }>>;
    }>;
}>, import("effect/Cause").YieldableError>;
/** Every implementation exists; pending check receipts are deliberately absent. */
export declare class EarlyFeedback extends EarlyFeedback_base {
}
export {};
