import * as Schema from "effect/Schema";
declare const ChangeSetUnreadable_base: Schema.Class<ChangeSetUnreadable, Schema.TaggedStruct<"smithers-review/ChangeSetUnreadable", {
    readonly repo: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** Repository preparation failed before a review could start. */
export declare class ChangeSetUnreadable extends ChangeSetUnreadable_base {
}
declare const WalkthroughUnwritable_base: Schema.Class<WalkthroughUnwritable, Schema.TaggedStruct<"smithers-review/WalkthroughUnwritable", {
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** The rendered walkthrough could not be stored. */
export declare class WalkthroughUnwritable extends WalkthroughUnwritable_base {
}
/** Operational failures preserved across every review round. */
export declare const ReviewFailure: Schema.Union<readonly [typeof ChangeSetUnreadable, typeof WalkthroughUnwritable]>;
/** A diagnostic from a failed local operation. */
export declare const reasonOf: (cause: unknown) => string;
export {};
