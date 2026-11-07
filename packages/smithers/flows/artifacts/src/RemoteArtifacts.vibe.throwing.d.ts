import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import * as ArtifactStore from "./ArtifactStore.ts";
/**
 * How eagerly a composition materializes shared blobs into its local store.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const DownloadPolicy: Schema.Literals<readonly ["all", "toplevel", "minimal"]>;
/**
 * How eagerly a composition materializes remote blobs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type DownloadPolicy = typeof DownloadPolicy.Type;
/**
 * A remote artifact tier, which is an ordinary store that also states how
 * eagerly a composition reading through it should materialize blobs locally.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Service extends ArtifactStore.Service {
    readonly downloadPolicy: DownloadPolicy;
}
/**
 * How to reach the shared artifact tier.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Options {
    /**
     * The cache root, e.g. `https://cache.example.com`. `/cas/{digest}` and
     * `/cas/findMissing` are resolved beneath it. A trailing slash is ignored.
     *
     * Four shapes are refused at construction as `invalid_configuration`, before
     * any request leaves and therefore before `headers` can reach a wire: a value
     * that is not a string, one no `URL` parser accepts, a scheme other than
     * `https:` (plain `http:` is accepted only for the literal loopback hosts
     * `localhost`, `127.0.0.1`, and `[::1]`), and an endpoint carrying
     * userinfo, a query, or a fragment. The
     * last rule keeps a credential out of a place nothing here would redact: an
     * endpoint is interpolated into every request path and into span attributes.
     *
     * The refusal message names only the violated rule and never echoes the
     * endpoint, so a rejected `https://user:secret@host` cannot leak its
     * credential into a log line or a durable error.
     */
    readonly endpoint: string;
    /**
     * Headers sent with every request — an `Authorization` bearer token, a
     * tenant header, whatever the deployment's gateway wants. This is the
     * credential seam, and it is deliberately construction-time: a credential
     * that arrived as a step input would be hashed into a step key and persisted
     * everywhere the journal goes.
     *
     * The protocol wins every collision. These headers are applied to a request
     * first. Configured `content-type`, `content-length`, and `content-range`
     * are removed, then computed only where the protocol needs them. Whole-blob
     * uploads, including fallbacks, never carry `content-range`.
     * All configured header names are redacted in HTTP spans, in addition to
     * the host's existing redaction rules.
     *
     * A name that is not an HTTP token, or a value longer than 16 KiB or
     * carrying a control character (CR and LF included), is refused at
     * construction as `invalid_configuration`.
     */
    readonly headers?: Record<string, string> | undefined;
    /**
     * The deadline on a single download, from the request leaving to the last
     * body byte arriving. A shared tier that stops answering must fail the read
     * rather than park it forever. `CombinedArtifacts.get` propagates a remote
     * `ArtifactStoreError`, including a download timeout. Only opportunistic
     * uploads from `CombinedArtifacts.put` ignore remote failures;
     * `ArtifactSync.hydrate` separately turns a failure into replay rejection.
     * Defaults to 60 seconds, Bazel's `--remote_timeout`
     * default for the same REST protocol (its `RemoteOptions`: "For the REST
     * cache, this is both the connect and the read timeout").
     */
    readonly downloadTimeout?: Duration.Input | undefined;
    /**
     * Deadline for an upload, including every resume probe and chunk. Defaults
     * to 60 seconds.
     */
    readonly uploadTimeout?: Duration.Input | undefined;
    /**
     * Deadline for an existence probe or one `findMissing` batch, including its
     * response body. Defaults to 60 seconds.
     */
    readonly requestTimeout?: Duration.Input | undefined;
    /**
     * The largest download this client will buffer, in bytes. The body is read
     * incrementally and abandoned the moment it exceeds the bound — and refused
     * outright when `Content-Length` already declares the excess — so a
     * mis-serving or hostile cache cannot make this process buffer and hash an
     * arbitrarily large body before the digest check refuses it. Defaults to
     * 256 MiB.
     */
    readonly maxDownloadBytes?: number | undefined;
    /**
     * Largest `findMissing` response body accepted. Defaults to the protocol's
     * 256 KiB request/response bound and may only lower that bound.
     */
    readonly maxFindMissingResponseBytes?: number | undefined;
    /**
     * Above this many bytes an upload travels as a sequence of `Content-Range`
     * `PUT`s instead of one whole-blob body, and a transfer that died partway
     * resumes from the prefix the tier kept rather than starting over. See
     * {@link module:RemoteArtifacts | the chunked upload protocol} below.
     *
     * Absent by default: every upload is one whole-blob `PUT`, which is what
     * Bazel's dumb-HTTP client does and what every deployment already serving
     * this protocol expects. Set it when a proxy caps request bodies, or when
     * artifacts are large enough that losing a transfer is expensive.
     *
     * The repository's own hosted and self-hosted cache services answer the
     * ranged probe with `400`, so against them this dial degrades to one
     * whole-blob `PUT`, and their 16 MiB body cap refuses a larger blob with
     * `413` in either mode.
     */
    readonly chunkBytes?: number | undefined;
    /**
     * How eagerly a composition reading through this tier materializes blobs
     * into its local store. This is Bazel's `--remote_download_{all,toplevel,
     * minimal}` dial (`RemoteOutputChecker`), and it lives here because the
     * shared tier is the thing being conserved.
     *
     * - `all` (the default) prefetches every referenced blob when a replay is
     *   admitted, so the replay reads local bytes.
     * - `toplevel` prefetches nothing and materializes a blob into the local
     *   store on the first read that actually needs it.
     * - `minimal` prefetches nothing and materializes nothing: a read is served
     *   straight from the shared tier and the local store never grows.
     *
     * `CombinedArtifacts.get` honors the last two; `@smthrs/engine-store`'s
     * `ArtifactSync.hydrate` honors the first.
     */
    readonly downloadPolicy?: DownloadPolicy | undefined;
}
/**
 * Builds a remote artifact store over Effect's `HttpClient`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare const make: (options: Options) => Effect.Effect<Service, ArtifactStore.ArtifactStoreError, HttpClient.HttpClient>;
