import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Option, Result, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { checkUrl, siteOf } from "../src/features/web/url.ts"
import * as Body from "./Body.vibe"
import * as BodyLimits from "./BodyLimits.vibe"
import * as WriteAdmission from "./WriteAdmission.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("apps/mvp Worker WriteAdmission, BodyLimits, Body.readBounded & web/url security fuzz invariants", () => {
  it("web/url.checkUrl rejects non-http(s), credentials, same-origin & same-site embeds including trailing-dot FQDNs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scheme: Schema.Literals(["https", "http", "javascript", "data", "file"]),
        host: Schema.Literals([
          "app.smithers.sh",
          "app.smithers.sh.",
          "docs.smithers.sh",
          "docs.smithers.sh.",
          "smithers.sh.",
          "example.com",
          "localhost",
          "127.0.0.1"
        ]),
        userinfo: Schema.Literals(["", "user:pass@"]),
        mode: Schema.Literals(["embed", "tab"]),
        localHttp: Schema.Boolean,
        path: Schema.Literals(["/", "/app", "/docs?x=1"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scheme, host, userinfo, mode, localHttp, path }) =>
          Effect.sync(() => {
            const input = `${scheme}://${userinfo}${host}${path}`
            const checked = checkUrl(input, mode, { localHttp, appOrigin: "https://app.smithers.sh" })
            const bare = host.replace(/\.+$/, "")

            if (scheme !== "https" && scheme !== "http") {
              return !checked.ok && (checked.reason === "scheme" || checked.reason === "invalid")
            }
            if (scheme === "http" && !(mode === "tab" && localHttp && (host === "localhost" || host === "127.0.0.1"))) {
              return !checked.ok && checked.reason === "insecure"
            }
            if (userinfo !== "") {
              return !checked.ok && checked.reason === "credentials"
            }
            if (bare === "app.smithers.sh") {
              return !checked.ok && checked.reason === "same_origin"
            }
            if (mode === "embed" && (bare === "smithers.sh" || bare.endsWith(".smithers.sh"))) {
              return !checked.ok && checked.reason === "same_site"
            }
            if (siteOf(`${bare}.`) !== siteOf(bare)) return false
            return checked.ok
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("BodyLimits.forRequest, Body.readBounded & WriteAdmission.afterBody strictly enforce route byte caps and UTF-8 validity", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        route: Schema.Literals([
          "/api/auth/arrive",
          "/api/auth/sign-out",
          "/api/questions",
          "/api/message-pin",
          "/api/views",
          "/api/views/v1/state",
          "/api/web/preview",
          "/api/runs/r1/credential",
          "/api/runs/r1",
          "/api/watches",
          "/api/alert-channels",
          "/api/sandbox-limits",
          "/api/flows/f1",
          "/api/branches",
          "/api/branches/b1/shares",
          "/api/conversations/archive",
          "/api/texts/t1",
          "/api/terminals",
          "/api/sandbox/calls",
          "/api/repos",
          "/api/repos/o/r/writes",
          "/api/repos/o/r/asks",
          "/api/repos/o/r/issues/1/links",
          "/api/repos/o/r/pulls/1/review",
          "/api/repos/o/r/stack",
          "/api/repos/o/r/secrets/API",
          "/api/me/model/jev",
          "/api/me/model",
          "/api/me/model/test",
          "/api/bugs",
          "/api/repos/o/r/feeds/answers",
          "/api/repos/o/r/feeds",
          "/api/repos/o/r/domains",
          "/api/repos/o/r/runs",
          "/api/remote-runs/r1/steers",
          "/api/remote-runs/r1/stop",
          "/api/mcp/oauth/cb",
          "/api/model/v1",
          "/api/telemetry/logs",
          "/api/runners/r1",
          "/api/github/webhook",
          "/api/unknown/route"
        ]),
        bodyKind: Schema.Literals(["small_utf8", "oversize_stream", "bad_utf8", "oversize_header"]),
        method: Schema.Literals(["POST", "GET"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ route, bodyKind, method }) =>
          Effect.gen(function*() {
            const limit = yield* BodyLimits.forRequest(route)
            if (!Number.isInteger(limit) || limit < 0 || limit > BodyLimits.MAX_BODY_BYTES) return false

            // Test Body.readBounded with tight cap (16 bytes)
            const cap = 16
            let bytesObserved = -1
            const makeReq = () => {
              if (bodyKind === "oversize_header") {
                return HttpServerRequest.fromWeb(
                  new Request(`https://app.smithers.sh${route}`, {
                    method: "POST",
                    headers: { "content-length": String(cap + 10) },
                    body: "short"
                  })
                )
              }
              if (bodyKind === "bad_utf8") {
                return HttpServerRequest.fromWeb(
                  new Request(`https://app.smithers.sh${route}`, {
                    method: "POST",
                    body: new Uint8Array([0xff, 0xfe, 0xfd])
                  })
                )
              }
              if (bodyKind === "oversize_stream") {
                return HttpServerRequest.fromWeb(
                  new Request(`https://app.smithers.sh${route}`, {
                    method: "POST",
                    body: "x".repeat(cap + 5)
                  })
                )
              }
              return HttpServerRequest.fromWeb(
                new Request(`https://app.smithers.sh${route}`, {
                  method: "POST",
                  body: "hello world"
                })
              )
            }
            const bounded = yield* Effect.result(
              Body.readBounded(makeReq(), cap, (n) => {
                bytesObserved = n
              })
            )
            if (bodyKind === "small_utf8") {
              if (Result.isFailure(bounded) || bounded.success !== "hello world" || bytesObserved !== 11) return false
            } else if (bodyKind === "bad_utf8") {
              if (Result.isSuccess(bounded) || bounded.failure.reason !== "utf8") return false
            } else {
              if (Result.isSuccess(bounded) || bounded.failure.reason !== "too_large") return false
            }

            // Test WriteAdmission.afterBody enforces route caps on write methods & passes GET through
            const admReq = HttpServerRequest.fromWeb(
              new Request(`https://app.smithers.sh${route}`, {
                method,
                ...(method === "POST"
                  ? {
                    body: bodyKind === "oversize_header" || (limit === 0 && bodyKind !== "small_utf8")
                      ? "x".repeat(Math.min(limit + 1, 2048))
                      : ""
                  }
                  : {})
              })
            )
            const resp = yield* WriteAdmission.afterBody(
              Effect.succeed(HttpServerResponse.text("ok", { status: 200 })),
              Effect.succeed(Option.none())
            ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, admReq))
            if (method === "GET" && resp.status !== 200) return false
            if (method === "POST" && limit === 0 && bodyKind !== "small_utf8" && resp.status !== 413) return false
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
