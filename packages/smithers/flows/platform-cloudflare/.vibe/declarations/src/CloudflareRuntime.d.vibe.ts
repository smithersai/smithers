/**
 * The durable flow runtime for one execution on Cloudflare.
 *
 * It is the same `Runtime.layer` the Node and Bun hosts compose, over the
 * Cloudflare Host surface and an injected `SqlClient`, configured for a host
 * that drives one execution per invocation: the engine runs no sweep and
 * renews no lease (`sweep: { host }`), refuses every run but its own
 * execution, and judges an earlier incarnation of the same Durable Object
 * dead at once. Build it inside the invocation that drives the execution
 * (`ExecutionObject.alarm` does), so its connections close when that
 * invocation ends.
 *
 * @since 1.0.0
 */
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store";
import * as Layer from "effect/Layer";
import * as CloudflareHost from "./CloudflareHost.vibe";
/**
 * What one execution's runtime is configured with.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    /**
     * The Durable Object this runtime runs in, stable across its incarnations:
     * pass `ctx.id.toString()`. Every incarnation fences its writes as this
     * host, and one that finds a run held under this id by another incarnation
     * takes it at once.
     */
    readonly hostId: string;
    /** The one execution this runtime drives. Every other run is refused. */
    readonly executionId: string;
    /** Persisted intent's flow tag; avoids recovery queries for unrelated registrations. */
    readonly flow?: string | undefined;
}
/**
 * Provides the durable engine for one execution, with `registerFlows`
 * registered, over the `SqlClient` the caller provides.
 *
 * The caller provides the `SqlClient`, for example `@smthrs/database`'s
 * `PostgresDatabase.layer` over a Hyperdrive connection string, and whatever
 * `registerFlows` requires beyond the engine.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: <Registered, RegistrationError, RegistrationRequirements>(options: Options, registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>) => Layer.Layer<Registered | import("@smthrs/run-store/AttemptStore").AttemptStore | import("@smthrs/step-cache/CacheStore").CacheStore | import("@smthrs/engine-store/EngineStore").Driver | import("@smthrs/engine-store/DurableEngineState").DurableEngineState | import("@smthrs/database/DurableWriter").DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | import("@smthrs/run-store/RunStore").RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary, RegistrationError | import("@smthrs/journal/Journal").JournalError | import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient | Exclude<Exclude<Exclude<Exclude<Exclude<RegistrationRequirements, never>, import("@smthrs/run-store/AttemptStore").AttemptStore | import("@smthrs/step-cache/CacheStore").CacheStore | import("@smthrs/engine-store/EngineStore").Driver | import("@smthrs/engine-store/DurableEngineState").DurableEngineState | import("@smthrs/database/DurableWriter").DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | import("@smthrs/run-store/RunStore").RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, import("effect/Scope").Scope>, CloudflareHost.CloudflareHost>, never>>;
