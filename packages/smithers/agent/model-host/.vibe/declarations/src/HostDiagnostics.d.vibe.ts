/**
 * Bounded guest-side diagnostics for one hosted chat turn.
 *
 * A hosted guest that stops answering writes nothing an operator can read: its
 * only durable channel is the journal, and a turn wedged before its first
 * commit never reaches it. These records go wherever the host composition
 * sends them; the Node model host writes them to the guest's own standard
 * error, which the sandbox keeps, so the boundary between a provider response
 * and a journal callback can be read while the turn is still stuck. This
 * package never writes to a console or stream itself.
 *
 * @since 1.0.0-rc.0
 */
import { Clock, Effect, Scope } from "effect";
/**
 * The marker every record carries, so an operator can select them out of a
 * guest's log without parsing the rest of it.
 *
 * @category protocol
 * @since 1.0.0-rc.0
 */
export declare const HOST_DIAGNOSTIC_MARKER = "smithers.chat-host-diagnostic/v1";
/**
 * A diagnostic field value: approved counts, flags and protocol vocabulary only.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HostDiagnosticValue = number | string | boolean;
/**
 * Correlation and progress fields for one record.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HostDiagnosticFields {
    readonly [key: string]: HostDiagnosticValue;
}
/**
 * Records a turn's own progress, and an operation that has not finished while
 * it still has not finished.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface HostDiagnostics {
    /**
     * Records one instant of progress. Only named finite measurements, flags
     * and approved protocol strings pass. Other fields, including reserved
     * envelope keys, are omitted and counted in `droppedFields`. Unknown event
     * and phase labels become `diagnostics` and `refused`, respectively.
     */
    readonly record: (event: string, phase: string, fields?: HostDiagnosticFields) => void;
    /**
     * Starts an observation in the caller's Effect runtime and returns its
     * completion callback. Until completion it reports pending at a fixed interval, so a
     * request that never returns is visible before it is abandoned. Calls to
     * the completion after the first are ignored.
     */
    readonly begin: (event: string, fields?: HostDiagnosticFields) => Effect.Effect<(outcome?: HostDiagnosticFields) => void>;
}
/**
 * How a recorder bounds and routes its records.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HostDiagnosticOptions {
    /** The turn these records belong to; omitted when there is none to name. */
    readonly turnId?: string;
    /**
     * Where one newline-terminated record line goes, supplied by the host
     * composition. Without one the recorder is inert: it writes nothing, starts
     * no timer and reads no clock.
     */
    readonly write?: ((line: string) => void) | undefined;
    /** Host Effect clock and lifetime. Required when a sink is supplied. */
    readonly runtime?: {
        readonly clock: Clock.Clock;
        readonly scope: Scope.Scope;
    };
    /** Monotonic milliseconds. */
    readonly clock?: () => number;
    /** How often an unfinished operation repeats. */
    readonly pendingMillis?: number;
    /** Full start and end records per event name before only exceptional ones pass. */
    readonly detailLimit?: number;
    /** An operation at least this slow is recorded past the detail limit. */
    readonly slowMillis?: number;
    /** Records this recorder may write before it reports itself capped. */
    readonly limit?: number;
}
/**
 * Creates a bounded recorder. Nothing it writes names a host, header,
 * destination, credential or message, and its total output is bounded, so it
 * is safe to leave on for every hosted turn. Records reach only the `write`
 * sink the host passes; without one the recorder is inert.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const createHostDiagnostics: (options?: HostDiagnosticOptions) => HostDiagnostics;
/**
 * Builds a recorder using the caller's injected Effect clock and scope.
 * Closing that scope cancels unfinished diagnostic observations.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const makeHostDiagnostics: (options?: Omit<HostDiagnosticOptions, "runtime">) => Effect.Effect<HostDiagnostics, never, Scope.Scope>;
