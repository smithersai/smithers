/**
 * Typed failures of one model host turn.
 *
 * Each failure names where the turn stopped, so a log line or a metric can
 * tell a provider outage from a journal fencing refusal without reading cause
 * text. Messages are fixed strings and status codes only: provider and
 * transport causes can carry signed requests and never reach these values.
 *
 * @since 1.0.0-rc.1
 */
import type { HostDiagnosticFields } from "./HostDiagnostics.vibe";
declare const ResolveFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ResolveFailed";
} & Readonly<A>;
/**
 * The trusted host could not resolve the owner's configured model.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class ResolveFailed extends ResolveFailed_base<{
    readonly message: string;
}> {
}
declare const ProducerUnreachable_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ProducerUnreachable";
} & Readonly<A>;
/**
 * The durable producer endpoint could not be reached.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class ProducerUnreachable extends ProducerUnreachable_base<{
    readonly message: string;
    readonly step: "provider_started" | "commit";
    /**
     * How far the attempt got on the wire, as the transport observer recorded
     * it. The attempt's own record is written to the guest's log, which lives
     * only as long as the guest does; carrying it on the failure is what lets
     * the host answer the API with it, over the connection that still works.
     */
    readonly transport?: HostDiagnosticFields;
}> {
}
declare const ProviderStartRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ProviderStartRefused";
} & Readonly<A>;
/**
 * The durable producer refused the provider-start acknowledgment.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class ProviderStartRefused extends ProviderStartRefused_base<{
    readonly message: string;
    readonly status: number;
}> {
}
declare const CommitRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CommitRefused";
} & Readonly<A>;
/**
 * The durable producer refused a frame commit, for example a lost fence.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class CommitRefused extends CommitRefused_base<{
    readonly message: string;
    readonly status: number;
}> {
}
declare const ReceiptMismatch_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ReceiptMismatch";
} & Readonly<A>;
/**
 * A commit receipt was malformed or did not extend the committed cursor.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class ReceiptMismatch extends ReceiptMismatch_base<{
    readonly message: string;
}> {
}
/**
 * Every failure the durable producer reports.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export type ProducerError = ProducerUnreachable | ProviderStartRefused | CommitRefused | ReceiptMismatch;
declare const StreamTooLarge_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "StreamTooLarge";
} & Readonly<A>;
/**
 * A sealed model stream outgrew the bytes one response may hold.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class StreamTooLarge extends StreamTooLarge_base<{
    readonly limitBytes: number;
}> {
}
export {};
