/**
 * Faults of the journal's own background maintenance. They are logged and
 * damped, never surfaced to a caller's write, so a log reader classifies one by
 * `_tag` and `code` instead of a message.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Which background step refused.
 *
 * @category models
 * @since 1.0.0
 */
export declare const JournalInternalFaultCode: Schema.Literals<readonly ["compaction_capture_timeout"]>;
/**
 * The stable code of a {@link JournalInternalFault}.
 *
 * @category models
 * @since 1.0.0
 */
export type JournalInternalFaultCode = typeof JournalInternalFaultCode.Type;
declare const JournalInternalFault_base: Schema.Class<JournalInternalFault, Schema.TaggedStruct<"@smthrs/journal/JournalInternalFault", {
    readonly code: Schema.Literals<readonly ["compaction_capture_timeout"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A post-commit maintenance step that refused.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class JournalInternalFault extends JournalInternalFault_base {
    readonly name = "JournalInternalFault";
}
export {};
