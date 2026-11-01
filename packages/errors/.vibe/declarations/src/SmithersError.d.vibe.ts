/**
 * The error class the integration adapters raise.
 *
 * `SmithersError` carries a machine-readable {@link SmithersErrorCode}, a
 * human summary, caller-supplied `details`, and a documentation URL appended
 * to the message. It stores context verbatim and does not redact it.
 * Integration adapters must remove credentials before constructing it.
 * Adapters subclass it, `error IntegrationError extends SmithersError`, to add
 * their own typed fields and their own Effect tag; callers classify with the
 * tag or the code rather than by matching message text.
 *
 * @since 1.0.0
 */
import { type SmithersErrorCode } from "./ErrorCode.ts";
/**
 * Construction options for a {@link SmithersError}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorOptions {
    /**
     * Stored verbatim and not redacted. A cause of `undefined` is treated as no
     * cause, so the instance has no own `cause` property and a log or
     * `util.inspect` output has no `[cause]` line. A subclass may therefore
     * always include the key. Redact provider text such as a bot token in a URL
     * or an API key in a message before attaching it.
     */
    cause?: unknown;
    /** Set `false` to leave the documentation URL out of the message. */
    includeDocsUrl?: boolean;
}
declare const SmithersError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: string;
} & Readonly<A>;
/**
 * A Smithers integration failure, and an Effect tagged error.
 *
 * Each class is tagged with its own name: `Effect.catchTag("SmithersError")`
 * catches a base instance, an adapter's `error IntegrationError extends
 * SmithersError` is caught by `"IntegrationError"`, and `is SmithersError`
 * matches them all. The tag is also the name the error reports.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class SmithersError extends SmithersError_base<{
    /** The Effect tag: `"SmithersError"`, or a subclass's own name. */
    readonly _tag: string;
    /** The summary with the documentation URL appended, unless left out. */
    readonly message: string;
    /** The machine-readable classification. */
    readonly code: SmithersErrorCode;
    /** The message without the appended documentation URL. */
    readonly summary: string;
    /** Where the code is documented. */
    readonly docsUrl: string;
    /**
     * Caller-supplied context. The top-level record is copied and frozen at
     * construction, so adding, removing, or replacing a top-level key on the
     * caller's object afterwards cannot change it. Nested values are shared by
     * reference and are not deep-frozen, so a caller must not mutate an attached
     * nested record. Callers must redact credentials. Absent as an own property
     * when the caller supplies none.
     */
    readonly details?: Readonly<Record<string, unknown>>;
}> {
    /**
     * Constructs a tagged integration failure with a frozen shallow context copy.
     *
     * @param code - A code from the closed error catalog.
     * @param summary - Human-readable text; trailing documentation suffixes are removed.
     * @param details - Context already redacted by the caller; nested values remain shared.
     * @param options - The documentation switch and the verbatim cause.
     * @since 1.0.0
     */
    constructor(code: SmithersErrorCode, summary: string, details?: Record<string, unknown>, options?: SmithersErrorOptions);
    /**
     * Returns enumerable own fields without adding the message, stack, or cause.
     * Nested context values remain shared and are not redacted.
     *
     * @returns A new record containing the enumerable own fields.
     * @since 1.0.0
     */
    toJSON(): Record<string, unknown>;
}
/**
 * Whether `value` is a {@link SmithersError}.
 *
 * This refinement uses `instanceof` only. It does not detect an instance
 * produced by a duplicate copy of this package.
 *
 * @param value - Any value to classify using this module's constructor identity.
 * @returns Whether the value is an instance of this class or one of its subclasses.
 * @category refinements
 * @since 1.0.0
 */
export declare const isSmithersError: (value: unknown) => value is SmithersError;
export { hasSmithersErrorShape } from "./ErrorShape.ts";
