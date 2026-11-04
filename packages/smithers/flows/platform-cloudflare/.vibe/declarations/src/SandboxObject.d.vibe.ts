/**
 * The container Durable Object, as a function the object delegates to before
 * it uses its container.
 *
 * {@link wake} starts the container when it is not running, with internet
 * access off, on the instance type it names, re-arms its inactivity timeout,
 * and registers the outbound HTTP intercepts that are the box's only way
 * out. It is idempotent: an object calls it before each use of the
 * container, and a container already running costs a timeout and the
 * intercepts, re-registered.
 *
 * {@link rearm} re-arms the timeout of a container that runs, and starts
 * nothing. A Durable Object that restarts, after a deploy for one, starts
 * with no timeout, and Cloudflare then stops its container shortly after the
 * object goes idle; an object calls it once per incarnation and on each use
 * that doesn't wake the container.
 *
 * {@link run} runs a command in the container for its exit code alone, and
 * never pipes its output: workerd's exec pipes hold no bytes, so a command
 * whose output nobody reads blocks on its first write and its exit code
 * never comes.
 *
 * The function takes the container as a structural slice of an Effect
 * container client, so an Alchemy Durable Object's container handle passes in
 * as is (`R` is its `RuntimeContext`, `F` its `Fetcher`), and a test passes an
 * in-memory one. It keeps no state and runs no timer or retry of its own; the
 * container client's `start` coordinates concurrent starts.
 *
 * @since 1.0.0-rc.17
 */
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";
import type * as ContainerTerminal from "../../../src/ContainerTerminal.ts";
/**
 * The slice of an Effect container client {@link wake} uses.
 *
 * `F` is the container client's fetcher type: Alchemy's `Fetcher`, or a
 * Worker's own `Fetcher` for a raw `ctx.container`. An Alchemy Durable
 * Object's container handle satisfies it with `E` its start and container
 * errors and `R = RuntimeContext`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Machine<F, E = never, R = never> {
    readonly running: Effect.Effect<boolean, E, R>;
    start(options: {
        readonly enableInternet: false;
        readonly instance?: Instance;
    }): Effect.Effect<void, E, R>;
    setInactivityTimeout(durationMs: number): Effect.Effect<void, E, R>;
    interceptOutboundHttp(addr: string, binding: F): Effect.Effect<void, E, R>;
    interceptAllOutboundHttp(binding: F): Effect.Effect<void, E, R>;
    interceptOutboundHttps(addr: string, binding: F): Effect.Effect<void, E, R>;
}
/**
 * One outbound HTTP intercept: requests from the box to `host` (a host name,
 * or `host:port`) go to `fetcher`, outside the box, which can add a
 * credential the box never holds.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Intercept<F> {
    readonly host: string;
    readonly fetcher: F;
}
/**
 * A container's instance type, as `start` takes it: a named type, or custom
 * resources (`memoryMib` in mebibytes, `diskMb` in megabytes). Cloudflare
 * starts a container with none on `lite`: 1/16 vCPU, 256 MiB of memory and
 * 2 GB of disk.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Instance = "lite" | "basic" | "standard-1" | "standard-2" | "standard-3" | "standard-4" | {
    readonly vcpu: number;
    readonly memoryMib: number;
    readonly diskMb: number;
};
/**
 * Options for {@link wake}.
 *
 * - `intercepts`: every outbound HTTP intercept the box gets, registered on
 *   every wake.
 * - `instance`: the instance type a stopped container starts on; Cloudflare's
 *   default, `lite`, when absent.
 * - `startTimeoutMs`: the longest a stopped container's start may take before
 *   {@link wake} fails {@link StartTimedOut}; unbounded when absent.
 * - `inactivityTimeoutMs`: how long the container runs with no activity on
 *   its Durable Object before Cloudflare stops it. Defaults to
 *   {@link defaultInactivityTimeoutMs}.
 * - `egress`: where every other outbound request goes, HTTP and HTTPS
 *   alike: an egress that decides each one outside the box, such as
 *   `@smthrs/secrets`' `Egress.forward`. Without it, the box reaches only
 *   its intercepted hosts. HTTPS reaches it decrypted through the
 *   container's per-instance CA, which the box must trust.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface WakeOptions<F> {
    readonly intercepts: ReadonlyArray<Intercept<F>>;
    readonly instance?: Instance | undefined;
    readonly startTimeoutMs?: number | undefined;
    readonly inactivityTimeoutMs?: number | undefined;
    readonly egress?: F | undefined;
}
/**
 * What {@link wake} found: it `started` the container, or the container was
 * `running` already.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type WakeOutcome = "started" | "running";
/**
 * The inactivity timeout {@link wake} arms unless told another: 30 minutes.
 * It is the backstop that stops an idle container whose sleep never ran.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const defaultInactivityTimeoutMs: number;
/**
 * {@link wake} calls, by `outcome`: `started`, `running` or `failed`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const wakes: Metric.Counter<number>;
declare const StartTimedOut_base: Schema.Class<StartTimedOut, Schema.TaggedStruct<"@smthrs/platform-cloudflare/StartTimedOut", {
    readonly timeoutMs: Schema.Number;
}>, import("effect/Cause").YieldableError>;
/**
 * A stopped container didn't finish starting within {@link WakeOptions}'
 * `startTimeoutMs`. The start was abandoned; a later wake starts it again.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export declare class StartTimedOut extends StartTimedOut_base {
}
/**
 * Container starts that ran past their `startTimeoutMs` ({@link StartTimedOut}).
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const startTimeouts: Metric.Counter<number>;
/**
 * {@link rearm} calls, by `outcome`: `rearmed`, `stopped` or `failed`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const rearms: Metric.Counter<number>;
/**
 * Makes the container ready to use.
 *
 * 1. Starts it when it is not running, with `enableInternet: false` and
 *    `instance` when given: the box reaches nothing but the intercepted
 *    hosts. A start that runs past `startTimeoutMs` fails
 *    {@link StartTimedOut} and counts in {@link startTimeouts}.
 * 2. Arms its inactivity timeout, `inactivityTimeoutMs`. A restarted Durable
 *    Object loses the timeout, so every wake sets it again.
 * 3. Registers each intercept, in order, then, with `egress`, every other
 *    HTTP request (`interceptAllOutboundHttp`) and every HTTPS request
 *    (`interceptOutboundHttps("*")`). Intercepts must be registered again
 *    after each start; registering them on every wake also repairs an object
 *    that died between its start and its registration, which would otherwise
 *    leave a running box with no way out.
 *
 * It answers `started` or `running`. A failed start, timeout or
 * registration fails with the container client's own error, unchanged; the
 * span and the log line carry only its tag.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const wake: <F, E, R>(machine: Machine<F, E, R>, options: WakeOptions<F>) => Effect.Effect<WakeOutcome, E | StartTimedOut, R>;
/**
 * Re-arms the inactivity timeout of a container that runs, to
 * `inactivityTimeoutMs` ({@link defaultInactivityTimeoutMs} unless given),
 * and starts nothing. It answers `rearmed`, or `stopped` when the container
 * isn't running. A failed read or timeout fails with the container client's
 * own error, unchanged; the span and the log line carry only its tag.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const rearm: <F, E, R>(machine: Pick<Machine<F, E, R>, "running" | "setInactivityTimeout">, inactivityTimeoutMs?: number) => Effect.Effect<"rearmed" | "stopped", E, R>;
/**
 * Options for {@link run}: the `uid:gid` the command runs as (the image's
 * user when absent) and the variables it gets beyond the image's `PATH`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RunOptions {
    readonly user?: string | undefined;
    readonly env?: Record<string, string> | undefined;
}
/**
 * Runs `argv` in the running container to completion and answers its exit
 * code; a nonzero one is an answer, not a failure. Its standard output and
 * error are `ignore`d, never piped: workerd's exec pipes hold no bytes, so a
 * pipe nobody reads blocks the command on its first write, and its exit code
 * never comes. A command whose output matters runs through
 * `ContainerSession` instead. The process belongs to this call: it is killed
 * if the call is interrupted. A failed `exec` or wait fails with the
 * container client's own error.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const run: <E, R>(container: ContainerTerminal.Container<E, R>, argv: Array<string>, options?: RunOptions) => Effect.Effect<number, E, R>;
export {};
