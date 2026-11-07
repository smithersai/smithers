/**
 * A read-only git smart HTTP proxy: the forge a sandbox clones and fetches
 * through, with the credential added outside the sandbox.
 *
 * A sandbox's guest holds no credential. Its remote is the proxy's own URL,
 * such as `http://forge.smithers.internal/<owner>/<name>`, and every request
 * it sends there reaches {@link uploadPack}, which:
 *
 * - admits only the two requests a clone or fetch makes:
 *   `GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack`,
 *   protocol v0 or v2. Everything else, a push (`git-receive-pack`)
 *   included, is refused with 403 before anything is sent;
 * - sends it to the {@link GitRemote.Upstream} the host chose, which fixes
 *   the repository: the repository named in the guest's path is ignored;
 * - forwards only the headers git needs (`Content-Type`, `Content-Encoding` of
 *   the guest's own body, `Accept`, `Git-Protocol`), never the guest's own
 *   `Authorization`, and adds the upstream's credential;
 * - asks the upstream for an uncompressed answer (`Accept-Encoding:
 *   identity`) and streams it back with only its `Content-Type` and
 *   `Cache-Control`: the host's `fetch` decodes a compressed answer anyway
 *   (GitHub gzips `info/refs`), so a `Content-Encoding` passed on would name
 *   an encoding the bytes no longer have.
 *
 * Code Storage's guide to proxying git with your own auth has the same shape
 * (code.storage/docs/guides/proxy-git-with-your-own-auth, read 2026-10-20).
 *
 * Each request is one span, `GitProxy.uploadPack`, and one count on
 * `git_proxy_requests` by `service` and `outcome`, recorded when the answer's
 * body has ended, so a pack that breaks off counts as `broken`; neither
 * carries the credential, a path or any bytes.
 *
 * @since 0.2.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Metric from "effect/Metric"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import * as GitRemote from "./GitRemote.ts"
import { readAtMost } from "./internal/bounded.ts"
import { negotiation, packet, validBranch } from "./internal/scopedGit.ts"

/**
 * Which part of a fetch a request is: the ref advertisement, or the pack
 * negotiation.
 *
 * @category models
 * @since 0.2.0
 */
export type Service = "info-refs" | "upload-pack"

/**
 * The counter {@link uploadPack} updates once per request:
 * `git_proxy_requests`, by `service` (`info-refs`, `upload-pack`, or
 * `refused`) and `outcome` (`ok`, `refused`, the upstream's status class
 * such as `4xx`, `transport` when it didn't answer, or `broken` when its
 * answer broke off), once the answer's body has ended.
 *
 * @category observability
 * @since 0.2.0
 */
export const requests: Metric.Counter<number> = Metric.counter("git_proxy_requests", {
  description: "Requests through the read-only git proxy, by service and outcome",
  incremental: true
})

/** The request headers git needs; any other, the guest's `Authorization` included, is dropped. */
const forwardedRequestHeaders: ReadonlyArray<string> = ["content-type", "content-encoding", "accept", "git-protocol"]

/** The response headers the guest gets back: never `Content-Encoding`, which the host's `fetch` has undone. */
const forwardedResponseHeaders: ReadonlyArray<string> = ["content-type", "cache-control"]

/**
 * Which service a request asks for, or `undefined` when the proxy refuses
 * it: only `GET <path>/info/refs?service=git-upload-pack` and
 * `POST <path>/git-upload-pack`.
 *
 * @category routing
 * @since 0.2.0
 */
export const classify = (method: string, url: string): Service | undefined => {
  const parsed = new URL(url, "http://proxy")
  if (method === "GET" && parsed.pathname.endsWith("/info/refs")) {
    return parsed.searchParams.getAll("service").join(",") === "git-upload-pack" ? "info-refs" : undefined
  }
  if (method === "POST" && parsed.pathname.endsWith("/git-upload-pack") && parsed.search === "") {
    return "upload-pack"
  }
  return undefined
}

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`

/**
 * Answers one request from a guest by sending it to `upstream` with its
 * credential, or refuses it with 403. An optional `branch` confines the guest
 * to that branch: discovery negotiates protocol v0 and synthesizes HEAD and
 * that ref only; fetch permits only its current tip. Scoped requests are
 * bounded to 1 MiB, accept uncompressed protocol v0 only, and strip haves to
 * avoid exposing other objects through ACKs. Shallow, partial, and thin packs
 * and arbitrary capabilities are refused. A failed scoped ref read is 502.
 * Unscoped upstream failures come back as their
 * status; no answer at all is 502. Requires the host's `HttpClient`.
 *
 * @category proxy
 * @since 0.2.0
 */
export const uploadPack = (
  request: HttpServerRequest.HttpServerRequest,
  upstream: GitRemote.Upstream,
  branch?: string
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const service = classify(request.method, request.url)
    const done = (outcome: string, status: number) =>
      Effect.gen(function*() {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Metric.update(Metric.withAttributes(requests, { service: service ?? "refused", outcome }), 1)
        yield* Effect.annotateCurrentSpan({
          "git.proxy.service": service ?? "refused",
          "http.response.status_code": status
        })
        yield* Effect.logWithLevel(outcome === "ok" ? "Info" : "Warn")("git.proxy").pipe(
          Effect.annotateLogs({ service: service ?? "refused", outcome, status, durationMs })
        )
      })
    if (service === undefined) {
      yield* done("refused", 403)
      return HttpServerResponse.empty({ status: 403 })
    }
    let scopedBody: string | undefined
    if (branch !== undefined) {
      const encoding = request.headers["content-encoding"]
      const protocol = request.headers["git-protocol"]
      if (
        !validBranch(branch) || (encoding !== undefined && encoding !== "identity") ||
        (protocol !== undefined && !/^version=[012]$/.test(protocol))
      ) {
        yield* done("refused", 403)
        return HttpServerResponse.empty({ status: 403 })
      }
      const tip = yield* GitRemote.ref(upstream, branch).pipe(Effect.option)
      if (tip._tag === "None") {
        yield* done("transport", 502)
        return HttpServerResponse.empty({ status: 502 })
      }
      if (service === "info-refs") {
        yield* done("ok", 200)
        return HttpServerResponse.text(
          packet("# service=git-upload-pack\n") + "0000" +
            packet(`${tip.value} HEAD\0side-band-64k ofs-delta symref=HEAD:refs/heads/${branch}\n`) +
            packet(`${tip.value} refs/heads/${branch}\n`) + "0000",
          { headers: { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-store" } }
        )
      }
      const body = yield* readAtMost(request.stream, 1024 * 1024).pipe(Effect.option)
      scopedBody = body._tag === "Some" && !body.value.truncated
        ? negotiation(body.value.bytes, tip.value)
        : undefined
      if (scopedBody === undefined) {
        yield* done("refused", 403)
        return HttpServerResponse.empty({ status: 403 })
      }
    }
    const base = upstream.url.replace(/\/+$/, "")
    let outgoing = service === "info-refs"
      ? HttpClientRequest.get(`${base}/info/refs`).pipe(HttpClientRequest.setUrlParam("service", "git-upload-pack"))
      : HttpClientRequest.post(`${base}/git-upload-pack`).pipe(
        HttpClientRequest.setBody(
          HttpBody.stream(request.stream, request.headers["content-type"], undefined)
        )
      )
    if (scopedBody !== undefined) {
      outgoing = HttpClientRequest.bodyText(outgoing, scopedBody, "application/x-git-upload-pack-request")
    }
    for (const name of forwardedRequestHeaders) {
      if (branch !== undefined) continue
      const value = request.headers[name]
      if (value !== undefined) outgoing = HttpClientRequest.setHeader(outgoing, name, value)
    }
    outgoing = HttpClientRequest.setHeader(outgoing, "accept-encoding", "identity")
    if (upstream.authorization !== undefined) {
      outgoing = HttpClientRequest.setHeader(outgoing, "authorization", Redacted.value(upstream.authorization))
    }
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(outgoing).pipe(Effect.option)
    if (response._tag === "None") {
      yield* done("transport", 502)
      return HttpServerResponse.empty({ status: 502 })
    }
    const answer = response.value
    const headers: Record<string, string> = {}
    for (const name of forwardedResponseHeaders) {
      const value = answer.headers[name]
      if (value !== undefined) headers[name] = value
    }
    const outcome = answer.status < 300 ? "ok" : statusClass(answer.status)
    // Recorded once the body has ended, the way the guest saw it: whole, or broken off.
    const body = answer.stream.pipe(
      Stream.onExit((exit) => done(Exit.isSuccess(exit) ? outcome : "broken", answer.status))
    )
    return HttpServerResponse.stream(body, { status: answer.status, headers })
  }).pipe(Effect.withSpan("GitProxy.uploadPack", { kind: "server" }))
