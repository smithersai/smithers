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

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { readPackets } from "./internal/bounded.ts"

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
export class GitRemoteError extends Schema.TaggedError<GitRemoteError>()(
  "@smthrs/effect-code-storage/GitRemoteError",
  {
    code: Schema.Literals([
      "not_found",
      "empty",
      "ref_not_found",
      "unavailable",
      "transport",
      "too_large",
      "invalid_response"
    ]),
    status: Schema.optional(Schema.Number)
  }
) {
  /**
   * The code and the status, never any text from the remote.
   *
   * @since 0.1.0
   */
  override get message(): string {
    return `git remote: ${this.code}${this.status === undefined ? "" : ` (${this.status})`}`
  }
}

/**
 * A remote's HEAD: the commit it names, and the branch it points at.
 * `branch` is undefined when HEAD is detached.
 *
 * @category models
 * @since 0.1.0
 */
export interface Head {
  readonly sha: string
  readonly branch: string | undefined
}

/**
 * The counter {@link head} updates once per call: `git_remote_requests`, by
 * `outcome` (`ok`, or the failure's code).
 *
 * @category observability
 * @since 0.1.0
 */
export const requests: Metric.Counter<number> = Metric.counter("git_remote_requests", {
  description: "Git remote HEAD reads, by outcome",
  incremental: true
})

const maxAdvertisementBytes = 64 * 1024
// Fatal, so a payload that isn't UTF-8 is an error instead of U+FFFD in a branch name; BOM kept, so it can't hide.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** A complete payload as text, or `undefined` when it isn't UTF-8. */
const text = (payload: Uint8Array): string | undefined => {
  try {
    return utf8.decode(payload)
  } catch {
    return undefined
  }
}

/** How a read of pkt-lines ended: what it found, or why it found nothing. */
type Read<A> =
  | { readonly _tag: "Found"; readonly value: A }
  | { readonly _tag: "Empty" | "Invalid" }

/**
 * Reads HEAD from the start of a v0 smart HTTP advertisement: the service line, a flush, then the first ref, and no
 * further.
 */
const advertisedHead = () => {
  let seen = 0
  let read: Read<Head> | undefined
  const onPacket = (payload: Uint8Array | null): boolean => {
    const index = seen++
    if (index === 0) {
      if (payload === null || text(payload)?.startsWith("# service=git-upload-pack") !== true) {
        read = { _tag: "Invalid" }
        return false
      }
      return true
    }
    if (index === 1) {
      if (payload !== null) read = { _tag: "Invalid" }
      return payload === null
    }
    read = payload === null ? { _tag: "Empty" } : headOf(payload)
    return false
  }
  return { onPacket, result: () => read }
}

/** HEAD from the advertisement's first ref line: empty when it names no commit or another ref. */
const headOf = (payload: Uint8Array): Read<Head> => {
  const line = text(payload)
  if (line === undefined) return { _tag: "Invalid" }
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([^\0\n]+)(?:\0([^\n]*))?\n?$/.exec(line)
  if (match === null) return { _tag: "Invalid" }
  const [, sha, ref, capabilities = ""] = match
  if (ref !== "HEAD" || /^0+$/.test(sha!)) return { _tag: "Empty" }
  // Capabilities are separated by ASCII spaces only; a branch may hold any other character git allows, U+3000 included.
  const branch = /(?:^| )symref=HEAD:refs\/heads\/([^ ]+)/.exec(capabilities)?.[1]
  return { _tag: "Found", value: { sha: sha!, branch } }
}

/**
 * The failure for a read that found nothing: what it read said why, else it stopped at its cap (`too_large`), else
 * the answer ended too soon (`invalid_response`).
 */
const unread = (
  read: Read<unknown> | undefined,
  stopped: { readonly truncated: boolean; readonly invalid: boolean },
  status: number,
  empty: "empty" | "ref_not_found"
): GitRemoteError =>
  new GitRemoteError({
    code: read?._tag === "Empty"
      ? empty
      : read === undefined && !stopped.invalid && stopped.truncated
      ? "too_large"
      : "invalid_response",
    status
  })

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
  readonly url: string
  readonly authorization?: Redacted.Redacted<string> | undefined
}

const withCredential = (request: HttpClientRequest.HttpClientRequest, upstream: Upstream) =>
  upstream.authorization === undefined
    ? request
    : HttpClientRequest.setHeader(request, "authorization", Redacted.value(upstream.authorization))

/** One count on {@link requests} by how a read ended, and its span, which names only the remote's URL. */
const observed = (span: string, remote: string) => <A, R>(effect: Effect.Effect<A, GitRemoteError, R>) =>
  effect.pipe(
    Effect.onExit((exit) =>
      Metric.update(
        Metric.withAttributes(requests, {
          outcome: Exit.isSuccess(exit) ?
            "ok" :
            Option.match(Exit.findErrorOption(exit), { onNone: () => "interrupted", onSome: (error) => error.code })
        }),
        1
      )
    ),
    Effect.withSpan(span, { attributes: { "git.remote": remote } })
  )

/**
 * Reads the HEAD of the git remote at `remote`, such as
 * `https://github.com/octocat/Spoon-Knife.git`, with no credential, or of an
 * {@link Upstream} with its credential.
 *
 * @category reads
 * @since 0.1.0
 */
export const head = (remote: string | Upstream): Effect.Effect<Head, GitRemoteError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const upstream = typeof remote === "string" ? { url: remote } : remote
    const request = HttpClientRequest.get(`${upstream.url.replace(/\/+$/, "")}/info/refs`).pipe(
      HttpClientRequest.setUrlParam("service", "git-upload-pack"),
      (request) => withCredential(request, upstream)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(() => new GitRemoteError({ code: "transport" }))
    )
    const status = response.status
    if (status === 401 || status === 403 || status === 404) {
      return yield* new GitRemoteError({ code: "not_found", status })
    }
    if (status >= 300) return yield* new GitRemoteError({ code: "unavailable", status })
    if (!(response.headers["content-type"] ?? "").startsWith("application/x-git-upload-pack-advertisement")) {
      return yield* new GitRemoteError({ code: "invalid_response", status })
    }
    const reader = advertisedHead()
    const stopped = yield* readPackets(response.stream, maxAdvertisementBytes, reader.onPacket).pipe(
      Effect.mapError(() => new GitRemoteError({ code: "transport", status }))
    )
    const read = reader.result()
    if (read?._tag === "Found") return read.value
    return yield* unread(read, stopped, status, "empty")
  }).pipe(observed("GitRemote.head", typeof remote === "string" ? remote : remote.url))

/** The most of an `ls-refs` answer {@link ref} reads: one prefix's refs, far less. */
const maxRefsBytes = 1024 * 1024

const encoder = new TextEncoder()

/** One pkt-line: four hex digits of length, counting themselves, then the payload's UTF-8 bytes. */
const pkt = (line: string): Uint8Array => {
  const payload = encoder.encode(line)
  const framed = new Uint8Array(payload.length + 4)
  framed.set(encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), 0)
  framed.set(payload, 4)
  return framed
}

/** Protocol v2's `ls-refs` for refs under `prefix`: the command, a delimiter, the prefix, a flush. */
const lsRefs = (prefix: string): Uint8Array => {
  const parts = [
    pkt("command=ls-refs\n"),
    encoder.encode("0001"),
    pkt(`ref-prefix ${prefix}\n`),
    encoder.encode("0000")
  ]
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

/**
 * Reads an `ls-refs` answer line by line until the line naming `wanted`, which it takes, or the flush that ends the
 * answer, after which the remote has no such ref. Every line before the wanted one must be a ref line in UTF-8.
 */
const listedRef = (wanted: string) => {
  let read: Read<string> | undefined
  const onPacket = (payload: Uint8Array | null): boolean => {
    if (payload === null) {
      read = { _tag: "Empty" }
      return false
    }
    const line = text(payload)
    const match = line === undefined ? null : /^([0-9a-f]{40}|[0-9a-f]{64}) ([^ \n]+)(?: [^\n]*)?\n?$/.exec(line)
    if (match === null) {
      read = { _tag: "Invalid" }
      return false
    }
    if (match[2] !== wanted) return true
    read = { _tag: "Found", value: match[1]! }
    return false
  }
  return { onPacket, result: () => read }
}

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
export const ref = (upstream: Upstream, branch: string): Effect.Effect<string, GitRemoteError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const wanted = `refs/heads/${branch}`
    const request = HttpClientRequest.post(`${upstream.url.replace(/\/+$/, "")}/git-upload-pack`).pipe(
      HttpClientRequest.setHeader("git-protocol", "version=2"),
      HttpClientRequest.bodyUint8Array(lsRefs(wanted), "application/x-git-upload-pack-request"),
      (request) => withCredential(request, upstream)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(() => new GitRemoteError({ code: "transport" }))
    )
    const status = response.status
    if (status === 401 || status === 403 || status === 404) {
      return yield* new GitRemoteError({ code: "not_found", status })
    }
    if (status >= 300) return yield* new GitRemoteError({ code: "unavailable", status })
    if (!(response.headers["content-type"] ?? "").startsWith("application/x-git-upload-pack-result")) {
      return yield* new GitRemoteError({ code: "invalid_response", status })
    }
    const reader = listedRef(wanted)
    const stopped = yield* readPackets(response.stream, maxRefsBytes, reader.onPacket).pipe(
      Effect.mapError(() => new GitRemoteError({ code: "transport", status }))
    )
    const read = reader.result()
    if (read?._tag === "Found") return read.value
    return yield* unread(read, stopped, status, "ref_not_found")
  }).pipe(observed("GitRemote.ref", upstream.url))
