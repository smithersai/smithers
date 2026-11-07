/**
 * A git remote's HEAD, read over git's smart HTTP protocol with no
 * credentials.
 *
 * Before mirroring a public repository, a host needs its default branch and
 * that branch's commit, and to know it exists. GitHub's REST API answers
 * that, but limits callers without a token to 60 requests an hour per IP
 * address, which a Worker's shared egress exhausts. The git endpoint every
 * `git clone` uses has no such limit: `GET <remote>/info/refs?service=git-upload-pack`
 * advertises HEAD first, with `symref=HEAD:refs/heads/<branch>` among its
 * capabilities. {@link head} reads only that first line, at most 64 KiB,
 * and stops.
 *
 * Each call is one span, `GitRemote.head`, and one count on
 * `git_remote_requests` by `outcome`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
declare const GitRemoteError_base: Schema.Class<GitRemoteError, Schema.TaggedStruct<"@smthrs/effect-code-storage/GitRemoteError", {
    readonly code: Schema.Literals<readonly ["not_found", "empty", "ref_not_found", "unavailable", "transport", "too_large", "invalid_response"]>;
    readonly status: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/**
 * Why a remote's HEAD couldn't be read:
 *
 * - `not_found`: the remote answered 401, 403 or 404, which is how GitHub
 *   answers for a repository that is missing or private;
 * - `empty`: the remote has no HEAD, as a repository with no commits;
 * - `ref_not_found`: the remote has no such branch ({@link ref});
 * - `unavailable`: any other failing status, in `status`;
 * - `transport`: no answer, or the answer broke off;
 * - `too_large`: the answer passed the read's cap (64 KiB for {@link head},
 *   1 MiB for {@link ref}) before it said what was asked;
 * - `invalid_response`: an answer that isn't a smart HTTP ref advertisement
 *   or `ls-refs` answer, or whose lines it needed aren't UTF-8.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class GitRemoteError extends GitRemoteError_base {
    /**
     * The code and the status, never any text from the remote.
     *
     * @since 0.1.0
     */
    get message(): string;
}
/**
 * A remote's HEAD: the commit it names, and the branch it points at.
 * `branch` is undefined when HEAD is detached.
 *
 * @category models
 * @since 0.1.0
 */
export interface Head {
    readonly sha: string;
    readonly branch: string | undefined;
}
/**
 * The counter {@link head} updates once per call: `git_remote_requests`, by
 * `outcome` (`ok`, or the failure's code).
 *
 * @category observability
 * @since 0.1.0
 */
export declare const requests: Metric.Counter<number>;
/**
 * A git remote and the credential a host adds to every request it sends
 * there: an `Authorization` header value, such as Basic `t:<token>` for Code
 * Storage. The credential never leaves the host: a guest that clones through
 * `GitProxy` sees only the proxy's own URL.
 *
 * @category models
 * @since 0.2.0
 */
export interface Upstream {
    /** The remote's smart HTTP base, such as `https://github.com/octocat/Spoon-Knife.git`. */
    readonly url: string;
    readonly authorization?: Redacted.Redacted<string> | undefined;
}
/**
 * Reads the HEAD of the git remote at `remote`, such as
 * `https://github.com/octocat/Spoon-Knife.git`, with no credential, or of an
 * {@link Upstream} with its credential.
 *
 * @category reads
 * @since 0.1.0
 */
export declare const head: (remote: string | Upstream) => Effect.Effect<Head, GitRemoteError, HttpClient.HttpClient>;
/**
 * The commit branch `branch` points at on `upstream`, asked with git protocol v2's `ls-refs` for that one ref, with
 * the upstream's credential: a remote with thousands of pull request refs answers in one short line. A remote with no
 * such branch fails with `ref_not_found`.
 *
 * Each call is one span, `GitRemote.ref`, and one count on `git_remote_requests` by `outcome`; neither names the
 * credential.
 *
 * @category reads
 * @since 0.2.0
 */
export declare const ref: (upstream: Upstream, branch: string) => Effect.Effect<string, GitRemoteError, HttpClient.HttpClient>;
export {};
