/**
 * Defines the event supervision reports when it retires a session.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const SandboxUnhealthy_base: Schema.Class<SandboxUnhealthy, Schema.Struct<{
    readonly _tag: Schema.tag<"sandbox-unhealthy">;
    /** The provider-neutral session key that was retired. */
    readonly session: Schema.String;
    /** Why the probe declared the session dead. */
    readonly reason: Schema.Literals<readonly ["unresponsive", "ping_failed"]>;
    /** The probe's own description of the failure, when it had one. */
    readonly message: Schema.optional<Schema.String>;
    /** How many consecutive unhealthy probes it took to reach the verdict. */
    readonly probes: Schema.Int;
}>, {}>;
/**
 * A supervised sandbox session failed its liveness probe and was retired.
 *
 * The event is a schema class rather than a log line because a control plane
 * records it: a run that failed because its sandbox died reads very differently
 * from a run that failed on its own, and only this event tells them apart.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SandboxUnhealthy extends SandboxUnhealthy_base {
}
export {};
