/**
 * Channel contracts and the in-memory channel coordinator.
 *
 * A channel verifies opaque transport data before it decodes or maps it. The
 * resulting request is then dispatched through the Control service; channels
 * do not acquire an execution path of their own.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, type Schema } from "effect";
import { Control } from "../../../src/Control.ts";
import { type ControlError, InvalidInput, type Unauthorized, Unavailable } from "../../../src/ControlError.ts";
import { ControlRuntime } from "../../../src/ControlRuntime.ts";
import type { FlowId, IdempotencyKey, Receipt, RunId, RunSummary, SignalPayload } from "../../../src/ControlSchema.ts";
/**
 * Opaque request data passed to a channel before decoding.
 *
 * @category models
 * @since 0.1.0
 */
export interface RawInbound {
    readonly body: Uint8Array;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly idempotencyKey: IdempotencyKey;
}
/**
 * The channel mapping after a verified payload has been decoded.
 *
 * @category models
 * @since 0.1.0
 */
export type InboundResult = {
    readonly _tag: "Start";
    readonly flowId: FlowId;
    readonly input: unknown;
} | {
    readonly _tag: "Signal";
    readonly runId: RunId;
    readonly signal: SignalPayload;
};
/**
 * A process-local per-channel delivery record. `messageId` identifies an existing
 * platform message, so a reconnect can update it instead of posting again.
 *
 * @category models
 * @since 0.1.0
 */
export interface Delivery {
    readonly cursor: string;
    readonly messageId?: string | undefined;
}
/**
 * A side-effect-free outbound projection. Network delivery belongs to the
 * transport adapter, which consumes this value after it is journaled.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeliveryProjection {
    readonly cursor: string;
    readonly messageId?: string | undefined;
    readonly operation: "post" | "edit" | "noop";
    readonly message: unknown;
}
/**
 * A bidirectional platform adapter.
 *
 * `verify` must only inspect opaque bytes and headers. It always precedes
 * `decode`, preventing untrusted public requests from reaching planning.
 *
 * @category services
 * @since 0.1.0
 */
export interface Channel<A = unknown> {
    readonly name: string;
    readonly schema: Schema.Schema<A>;
    /**
     * Non-secret HTTP header names whose values change the decoded command.
     * Names are matched case-insensitively and folded into durable idempotency;
     * signature, authorization, and credential headers must not be declared.
     */
    readonly fingerprintHeaders?: ReadonlyArray<string> | undefined;
    readonly verify: (raw: RawInbound) => Effect.Effect<void, Unauthorized>;
    /** Deterministic, side-effect-free decoding; retries may evaluate it again. */
    readonly decode: (raw: RawInbound) => Effect.Effect<A, InvalidInput>;
    /** Deterministic, side-effect-free mapping; retries may evaluate it again. */
    readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>;
    readonly project: (run: RunSummary, delivery: Delivery | undefined) => DeliveryProjection;
}
/**
 * A registered channel with its payload type hidden. Decoding and mapping stay
 * paired, so lookup never exposes a mapper accepting arbitrary unknown data.
 *
 * @category models
 * @since 1.0.0
 */
export interface RegisteredChannel extends Omit<Channel, "decode" | "map"> {
    readonly decodeAndMap: (raw: RawInbound) => Effect.Effect<InboundResult, InvalidInput>;
}
/**
 * Arguments for ingesting one authenticated channel request.
 *
 * @category models
 * @since 0.1.0
 */
export interface IngestRequest {
    readonly channel: string;
    readonly raw: RawInbound;
}
/**
 * Arguments for projecting one run onto a channel.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectRequest {
    readonly channel: string;
    readonly run: RunSummary;
}
/**
 * The channel coordinator.
 *
 * @category services
 * @since 0.1.0
 */
export interface Channels {
    readonly register: <A>(channel: Channel<A>) => Effect.Effect<void>;
    readonly lookup: (name: string) => Effect.Effect<RegisteredChannel, Unavailable>;
    readonly ingest: (request: IngestRequest) => Effect.Effect<Receipt, ControlError>;
    readonly project: (request: ProjectRequest) => Effect.Effect<DeliveryProjection, Unavailable>;
}
/**
 * Service tag for channel registration, ingestion, and pure projection.
 *
 * @category services
 * @since 0.1.0
 */
export declare const Channels: Context.Service<Channels, Channels>;
/**
 * Builds the coordinator over Control's durable mutation store.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: Effect.Effect<Channels, never, Control | ControlRuntime>;
/**
 * Builds a process-local coordinator for adapter unit tests.
 *
 * Production hosts use {@link layer}; this constructor deliberately makes no
 * restart guarantee.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeMemory: Effect.Effect<Channels, never, Control>;
/**
 * Channel layer with durable inbound receipts supplied by `ControlRuntime`.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<Channels, never, Control | ControlRuntime>;
/**
 * Process-local channel layer for adapter unit tests only.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerMemory: Layer.Layer<Channels, never, Control>;
