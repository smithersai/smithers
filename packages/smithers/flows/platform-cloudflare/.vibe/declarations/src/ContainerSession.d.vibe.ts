/**
 * A container Durable Object's container as a `Sandbox.Session` from
 * `@smthrs/sandbox`: the seam through which `SandboxTools`, `Sandbox.layerHost`
 * and every other session consumer reach a Cloudflare container.
 *
 * {@link make} adapts a structural slice of an Effect container client, so an
 * Alchemy Durable Object's container handle passes in as is (`R` is its
 * `RuntimeContext`), and a test passes another. Every command runs with
 * `sh -c` as one user in one working directory; `readFile` and `writeFile`
 * are commands too, so the container needs only `sh` and `cat`.
 *
 * It starts nothing: the object wakes its container (`SandboxObject.wake`)
 * before it hands the session out. A failure of the container itself
 * surfaces as a `ProviderError` with code `unavailable`, its message naming
 * the operation and never the command or a path.
 *
 * The user is a numeric `uid:gid`: a deployed container's `exec` refuses a
 * user name and runs a bare `uid` as root, while local Docker accepts both.
 * A session given anything else fails every command with `spawn_error`
 * before it reaches the container, so development fails as production
 * would. A command inherits only `PATH` from the image; `env` carries the
 * rest, such as `HOME`.
 *
 * @since 1.0.0-rc.17
 */
import { type Sandbox } from "@smthrs/sandbox";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
/**
 * The options of one command {@link make}'s session runs: the slice of a
 * container's exec options it sets.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ExecOptions {
    readonly user?: string;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly stdin?: "pipe";
    readonly stdout: "pipe";
    readonly stderr: "pipe";
}
/**
 * A command running in the container: the slice of an Effect container
 * client's process {@link make} uses. `stdin` is present when the exec asked
 * for it, and completing it closes the command's input.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Process<E = never, R = never> {
    readonly stdin: Sink.Sink<unknown, Uint8Array, unknown, E, R> | undefined;
    readonly stdout: Stream.Stream<Uint8Array, E, R> | undefined;
    readonly stderr: Stream.Stream<Uint8Array, E, R> | undefined;
    readonly exitCode: Effect.Effect<number, E, R>;
}
/**
 * The slice of an Effect container client {@link make} uses: `exec`, which
 * runs an argument vector in the running container. The process belongs to
 * the scope that ran `exec`.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Container<E = never, R = never> {
    exec(cmd: Array<string>, options: ExecOptions): Effect.Effect<Process<E, R>, E, R | Scope.Scope>;
}
/**
 * Options for {@link make}.
 *
 * - `id`: the session's key, and the `remoteId` it reports.
 * - `workdir`: the absolute directory commands run in unless they name
 *   another; a relative `cwd` is taken under it.
 * - `user`: the `uid:gid` every command runs as, such as `1000:2000` or
 *   `0:0` for root; the image's user when absent.
 * - `env`: variables every command gets, under the command's own.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Options {
    readonly id: string;
    readonly workdir: string;
    readonly user?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
}
/**
 * The container as a session. Needs `R`, the container client's own
 * requirement, once, here; the session's operations carry it.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export declare const make: <E, R>(container: Container<E, R>, options: Options) => Effect.Effect<Sandbox.Session, never, R>;
