/**
 * Optional wire diagnostics. Hosts provide a sink explicitly; model calls never
 * read an ambient environment variable or open a file by default.
 *
 * @since 1.0.0
 */
import { Context, Effect, FileSystem, Layer } from "effect";
/**
 * Receives credential-free request and response records. Sink failures are
 * diagnostic failures and never fail the model call.
 *
 * @category services
 * @since 1.0.0
 */
export interface WireTrace {
    /** Maximum wait per cooperative write in milliseconds; nonpositive or nonfinite values use 1,000. */
    readonly writeTimeoutMs?: number | undefined;
    /** Writes one record; signed headers and user content are never supplied. */
    readonly write: (record: Readonly<Record<string, unknown>>) => Effect.Effect<void, unknown>;
}
/**
 * Optional sink captured when `Route.toModel` or `Route.layer` builds a model.
 *
 * @category services
 * @since 1.0.0
 */
export declare const WireTrace: Context.Service<WireTrace, WireTrace>;
/**
 * Appends paired JSON lines through the host's injected filesystem. Provide this
 * layer to the route's construction, and supply `NodeHost.layer` from
 * `@smthrs/platform-node` (or another host's filesystem) to this layer.
 * The host chooses the path; `SMITHERS_WIRE_TRACE` is no longer read implicitly.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerFileSystem: (path: string) => Layer.Layer<WireTrace, never, FileSystem.FileSystem>;
