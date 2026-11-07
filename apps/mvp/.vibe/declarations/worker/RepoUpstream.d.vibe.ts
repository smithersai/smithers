import { GitRemote } from "@smthrs/effect-code-storage";
import { Context, Effect, Layer, Schema } from "effect";
import type { HttpClient } from "effect/http";
import * as ReadToken from "../../../worker/github/ReadToken.ts";
import type { Size } from "../../../worker/Repos.ts";
declare const UpstreamUnavailable_base: Schema.Class<UpstreamUnavailable, Schema.TaggedStruct<"@smthrs/mvp/repo/UpstreamUnavailable", {
    readonly retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/** GitHub couldn't answer the size call. `retryAfterMillis` is the wait it asked for, which the step honors. */
export declare class UpstreamUnavailable extends UpstreamUnavailable_base {
}
/** What GitHub said of a repository's size: its bytes, rate limited until `retryAt`, or no such repository. */
export type Sized = Size | {
    readonly missing: true;
};
/** How long to wait for the size when GitHub rate limits without naming its reset. */
export declare const DEFAULT_RATE_LIMIT_WAIT_MS: number;
declare const RepoUpstream_base: Context.ServiceClass<RepoUpstream, "@smthrs/mvp/repo/RepoUpstream", {
    /** The repository's HEAD: its commit and default branch. */
    readonly head: (owner: string, name: string) => Effect.Effect<GitRemote.Head, GitRemote.GitRemoteError>;
    /** The repository's size, which GitHub reports in KiB and computes hourly. */
    readonly size: (owner: string, name: string) => Effect.Effect<Sized, UpstreamUnavailable>;
}>;
export declare class RepoUpstream extends RepoUpstream_base {
    /**
     * GitHub over the `HttpClient` in context: git's smart HTTP for HEAD, and `GET /repos/<owner>/<name>` for the size,
     * with the token `token` answers for that call (worker/github/ReadToken.ts: a bot token or the GitHub App's, 5,000
     * calls an hour) when it answers one, else unauthenticated (60 an hour per IP).
     */
    static readonly layer: (options: {
        readonly token: ReadToken.ReadToken;
    }) => Layer.Layer<RepoUpstream, never, HttpClient.HttpClient>;
    /** `layer` with the deployment's read token: `GITHUB_TOKEN`, else the GitHub App's, else none (`ReadToken.fromConfig`). */
    static readonly layerConfig: Layer.Layer<RepoUpstream, import("effect/Config").ConfigError, HttpClient.HttpClient>;
}
export {};
