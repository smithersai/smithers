import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { GitProxy, GitRemote } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("@smthrs/effect-code-storage GitProxy & GitRemote fuzz invariants", () => {
  it("GitProxy.classify & uploadPack NEVER permit git-receive-pack (push) or non-read methods, and never leak credentials", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH"]),
        path: Schema.Literals([
          "/repo.git/info/refs",
          "/repo.git/git-upload-pack",
          "/repo.git/git-receive-pack",
          "/repo.git/HEAD",
          "/repo.git/objects/pack/foo"
        ]),
        query: Schema.Literals([
          "",
          "?service=git-upload-pack",
          "?service=git-receive-pack",
          "?service=git-upload-pack&service=git-receive-pack",
          "?foo=bar"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, path, query }) =>
          Effect.gen(function*() {
            let upstreamCalled = false
            const fakeClient = HttpClient.make((req) => {
              upstreamCalled = true
              return Effect.succeed(
                HttpClientResponse.fromWeb(req, new Response("0000", { status: 200 }))
              )
            })
            const url = `https://proxy.example${path}${query}`
            const kind = GitProxy.classify(method, url)
            if (path.includes("receive-pack") || query.includes("receive-pack")) {
              if (kind !== undefined) return false
            }
            const serverReq = HttpServerRequest.fromWeb(
              new Request(url, {
                method,
                ...(method === "POST" || method === "PUT" || method === "PATCH" ? { body: "0000" } : {})
              })
            )
            const res = yield* GitProxy.uploadPack(serverReq, {
              url: "https://git.internal/repo.git",
              authorization: Redacted.make("Bearer TOP_SECRET_GIT_TOKEN_999")
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpClient.HttpClient, fakeClient),
                  silentLogger
                )
              )
            )
            if (kind === undefined) {
              if (upstreamCalled || res.status !== 403) return false
            } else {
              if (!upstreamCalled || res.status !== 200) return false
            }
            for (const v of Object.values(res.headers)) {
              if (String(v).includes("TOP_SECRET_GIT_TOKEN_999")) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitRemote.head never throws unhandled errors on arbitrary/corrupt pkt-line upstream payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
        Schema.Literals([
          "",
          "0000",
          "001e# service=git-upload-pack\n0000",
          "zzzzinvalidlength",
          "0003",
          "fffftruncated"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (payload) =>
          Effect.gen(function*() {
            const fakeClient = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(payload, {
                    status: 200,
                    headers: { "content-type": "application/x-git-upload-pack-advertisement" }
                  })
                )
              )
            )
            const res = yield* Effect.result(
              GitRemote.head("https://git.example/repo.git").pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(HttpClient.HttpClient, fakeClient),
                    silentLogger
                  )
                )
              )
            )
            if (Result.isFailure(res)) {
              return res.failure._tag === "@smthrs/effect-code-storage/GitRemoteError"
            }
            return typeof res.success.sha === "string" && /^[0-9a-f]{40}$/i.test(res.success.sha)
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
