/**
 * The gateway read path: served projections computed from the control plane.
 *
 * Every projection here is a fold over facts `@smthrs/control` already
 * publishes: `Control.list` for run and flow listings, `Control.watch` for a
 * run's ordered events. The gateway never opens the engine database, so a
 * projection served to a browser through a relay is the same projection a
 * local reader computes, and a projection cannot drift from the control plane
 * by reading a column the control plane does not expose.
 *
 * A snapshot brackets its journal read with run-summary reads and retries
 * when the summary changes. Rows and cursor share the resulting event buffer,
 * so a completion cannot be acknowledged with the preceding run status.
 *
 * A subscription is a snapshot followed by deltas. A delta recomputes the
 * selector's rows from the accumulated events rather than patching them: a
 * projection is a reproducible fold (`@smthrs/journal` `Projection`), and
 * recomputation is the only delta that cannot disagree with a fresh snapshot.
 * `run-events` appends immutable rows. `transcript` normally appends too, but
 * sends an existing snapshot reset when a committed native call fact upgrades
 * previously delivered telemetry. Events accumulate in the stream, so each delta
 * folds without re-reading history. Resuming a historical run summary first
 * rebuilds its compacted health prefix once through durable follow replay.
 *
 * A workspace subscription follows every journal partition without a cursor.
 * The follower stores each retained run's last position and drops replay
 * through that cutoff. Sources and exclusion verdicts share the snapshot's
 * run ceiling; eviction discards a verdict together with its cursor state.
 * Events are gathered for a short window and folded into one frame, and each
 * run's rows are cached so a burst refolds only the runs whose journals grew.
 *
 * @since 1.0.0
 */
import type { Service as ControlService } from "@smthrs/control/Control";
import { Control } from "@smthrs/control/Control";
import { Context, Effect, Layer, Stream } from "effect";
import { GatewayError } from "./GatewayError.vibe";
import * as GatewaySchema from "./GatewaySchema.vibe";
/**
 * How often an idle subscription emits a keepalive frame.
 *
 * The Smithers Cloud relay cuts an idle tunnel at 600 s (the deployed relay behavior), so a
 * quiet run must produce a frame well inside that window or the connection is
 * dropped and every follower reconnects. Thirty seconds leaves twenty
 * heartbeats of margin.
 *
 * @since 1.0.0
 * @category models
 */
export declare const heartbeatIntervalMillis = 30000;
/**
 * The most runs one workspace projection folds, newest first.
 *
 * A workspace projection reads one full journal per run, so the number of
 * runs it folds is bounded on purpose. This is the gateway's own ceiling, not
 * the control plane's default page size. It is 500 because that equals
 * `ControlSchema.maxPageSize`, letting the control plane satisfy the whole
 * gateway allowance in one page when it can.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxWorkspaceRuns = 500;
/**
 * The most journal events one run projection retains in its window.
 *
 * This is a retention ceiling, not a refusal. A run that journals more keeps
 * its most recent {@link maxEventsPerRun} events and folds everything older
 * into the carried digest that {@link maxProjectionBytes} describes.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxEventsPerRun = 10000;
/**
 * The most journal events one run projection reads before it stops reading.
 *
 * The window ceiling bounds memory; this bounds work. A projection folds every
 * event it reads, so a run with a million of them would cost a million decodes
 * on every snapshot however few it kept. Ten times the window is the honest
 * compromise: every real run is far inside it, and a runaway one still answers
 * rather than running the reader out of time.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxEventsScanned = 100000;
/**
 * The most events one `run-events` snapshot page carries.
 *
 * `run-events` is the one selector whose rows are the journal itself, so it is
 * the one selector a client must page rather than fold. A snapshot answers at
 * most this many events and a cursor to ask for the next page from, so reading
 * a long run costs one bounded response per page instead of one response the
 * size of the whole run.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxEventsPerPage = 1000;
/**
 * The most terminal runs of one flow a duration fold measures.
 *
 * A prediction wants recent history, not all of it: an old run measured a
 * different declaration on a different machine. The newest finished runs are
 * the ones whose durations still describe what the flow does now, and the
 * bound is what keeps a snapshot from reading every journal a flow ever wrote.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxDurationRuns = 20;
/**
 * The largest encoded event window or projected row set one run admits.
 *
 * The row budget is a refusal: rows go on the wire, and a frame larger than
 * this is one no client asked for. The window budget is retention: events
 * older than the newest {@link maxProjectionBytes} are folded into a carried
 * digest instead of being held. Its compact identity contributions share this
 * budget; if they cannot fit, the read refuses instead of reporting inexact
 * counters or retaining an unbounded identity set.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxProjectionBytes: number;
/**
 * The largest encoded form one retained journal event may take.
 *
 * A model request body, a response transcript, and a tool's captured output
 * are all journaled inline, and any one of them can be megabytes. Nothing a
 * projection reads out of a payload is long: a seat name, a flow name, an
 * outcome, a token count, a first line. A retained event is therefore clipped
 * to this budget rather than held whole, which is what keeps one wiki refresh
 * that retried a model call nine times from costing a run card its whole
 * history. `run-events` pages preserve native engine evidence because clients
 * decode its complete contracts to offer actions. Other large bodies remain
 * clipped; their full content belongs in run artifacts.
 *
 * @since 1.0.0
 * @category models
 */
export declare const maxEventBytes: number;
/**
 * Read-path operations served by the gateway.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
    /**
     * Current rows, or only run-events rows after an issued cursor.
     *
     * A literal selector keeps its own row type, so an approvals reader reads
     * `requestId` and a run-tree reader reads `nodeId` without an assertion. A
     * selector chosen at runtime still answers with the snapshot union.
     */
    readonly snapshot: <S extends GatewaySchema.ProjectionSelector>(selector: S, after?: GatewaySchema.ProjectionCursor | undefined) => Effect.Effect<GatewaySchema.SnapshotOf<S>, GatewayError>;
    /**
     * A snapshot followed by recomputed deltas and keepalive frames, or, when
     * `after` names a cursor this selector issued, the deltas after it alone.
     *
     * The row and delta frames are the selector's own, on the same rule as
     * `snapshot`.
     */
    readonly subscribe: <S extends GatewaySchema.ProjectionSelector>(selector: S, after?: GatewaySchema.ProjectionCursor | undefined) => Stream.Stream<GatewaySchema.FrameOf<S>, GatewayError>;
}
declare const Projections_base: Context.ServiceClass<Projections, "@smthrs/gateway/Projections", Service>;
/**
 * The gateway read path.
 *
 * @since 1.0.0
 * @category services
 */
export declare class Projections extends Projections_base {
}
/**
 * Builds the read path over a control plane.
 *
 * Invalid keepalive settings are returned as typed `bind_failed` failures;
 * construction never throws synchronously.
 *
 * @param control the control service to read through
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category constructors
 */
export declare const make: (control: ControlService, options?: {
    readonly heartbeatMillis?: number | undefined;
}) => Effect.Effect<Service, GatewayError>;
/**
 * Provides the gateway read path over the ambient control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export declare const layer: Layer.Layer<Projections, GatewayError, Control>;
/**
 * Provides the gateway read path under an explicit keepalive cadence.
 *
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category layers
 */
export declare const layerWith: (options: {
    readonly heartbeatMillis?: number | undefined;
}) => Layer.Layer<Projections, GatewayError, Control>;
export {};
