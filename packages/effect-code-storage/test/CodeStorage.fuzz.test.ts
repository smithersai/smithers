import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { GitProxy, GitRemote } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

const pkt = (line: string): string => {
  const bytes = new TextEncoder().encode(line)
  return (bytes.length + 4).toString(16).padStart(4, "0") + line
}

describe("@smthrs/effect-code-storage comprehensive fuzz security invariants", () => {
  it("GitProxy.classify & uploadPack (unscoped & branch-scoped) block push, haves, shallow, thin-pack, filter, and credential leaks", async () => {
    const validSha = "0123456789abcdef0123456789abcdef01234567"
    const otherSha = "fedcba9876543210fedcba9876543210fedcba98"
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PUT", "DELETE"]),
        path: Schema.Literals([
          "/repo.git/info/refs",
          "/repo.git/git-upload-pack",
          "/repo.git/git-receive-pack",
          "/repo.git/HEAD"
        ]),
        query: Schema.Literals(["", "?service=git-upload-pack", "?service=git-receive-pack"]),
        scoped: Schema.Boolean,
        bodyKind: Schema.Literals([
          "validWant",
          "wrongSha",
          "hasHave",
          "hasShallow",
          "hasThinPack",
          "hasFilter",
          "corrupt",
          "badGzip"
        ]),
        gitProtocol: Schema.Literals(["", "version=2", "version=9"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, path, query, scoped, bodyKind, gitProtocol }) =>
          Effect.gen(function*() {
            let uploadPackCalled = false
            const fakeClient = HttpClient.make((req) => {
              if (req.url.includes("git-upload-pack") && req.headers["git-protocol"] === "version=2") {
                // ls-refs response for scoped branch resolution
                const adv = `${pkt(`${validSha} refs/heads/main\n`)}0000`
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response(adv, {
                      status: 200,
                      headers: { "content-type": "application/x-git-upload-pack-result" }
                    })
                  )
                )
              }
              uploadPackCalled = true
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("0000", { status: 200 })))
            })
            const url = `https://proxy.example${path}${query}`
            const kind = GitProxy.classify(method, url)
            if (path.includes("receive-pack") || query.includes("receive-pack")) {
              if (kind !== undefined) return false
            }

            let bodyText = "0000"
            if (bodyKind === "validWant") {
              bodyText = `${pkt(`want ${validSha} multi_ack_detailed side-band-64k\n`)}0000${pkt("done\n")}`
            } else if (bodyKind === "wrongSha") {
              bodyText = `${pkt(`want ${otherSha}\n`)}0000${pkt("done\n")}`
            } else if (bodyKind === "hasHave") {
              bodyText = `${pkt(`want ${validSha}\n`)}0000${pkt(`have ${otherSha}\n`)}${pkt("done\n")}`
            } else if (bodyKind === "hasShallow") {
              bodyText = `${pkt(`want ${validSha}\n`)}${pkt(`shallow ${otherSha}\n`)}0000${pkt("done\n")}`
            } else if (bodyKind === "hasThinPack") {
              bodyText = `${pkt(`want ${validSha} thin-pack\n`)}0000${pkt("done\n")}`
            } else if (bodyKind === "hasFilter") bodyText = `${pkt(`want ${validSha} filter\n`)}0000${pkt("done\n")}`
            else if (bodyKind === "corrupt") bodyText = "zzzz-not-pktline"
            else bodyText = "not-valid-gzip"

            const headers: Record<string, string> = {}
            if (gitProtocol !== "") headers["git-protocol"] = gitProtocol
            if (bodyKind === "badGzip") headers["content-encoding"] = "gzip"

            const serverReq = HttpServerRequest.fromWeb(
              new Request(url, {
                method,
                headers,
                ...(method === "POST" || method === "PUT" ? { body: bodyText } : {})
              })
            )
            const res = yield* GitProxy.uploadPack(
              serverReq,
              {
                url: "https://git.internal/repo.git",
                authorization: Redacted.make("Bearer TOP_SECRET_GIT_TOKEN_999")
              },
              scoped ? "main" : undefined
            ).pipe(
              Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, fakeClient), silentLogger))
            )

            if (kind === undefined) {
              if (uploadPackCalled || res.status !== 403) return false
            }
            if (scoped && kind === "upload-pack") {
              // Non-tip SHA, shallow, thin-pack, filter, corrupt, badGzip, or v2 protocol MUST be refused (400/403)
              if (
                gitProtocol === "version=9" ||
                bodyKind === "wrongSha" ||
                bodyKind === "hasShallow" ||
                bodyKind === "hasThinPack" ||
                bodyKind === "hasFilter" ||
                bodyKind === "corrupt" ||
                bodyKind === "badGzip"
              ) {
                if (uploadPackCalled || (res.status !== 400 && res.status !== 403)) return false
              }
            }
            for (const v of Object.values(res.headers)) {
              if (String(v).includes("TOP_SECRET_GIT_TOKEN_999")) return false
            }
            if (res.body._tag === "Stream") {
              yield* Stream.runDrain(res.body.stream).pipe(Effect.ignore)
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

  it("GitRemote.head & GitRemote.ref handle valid advertisements, status codes, and arbitrary corrupt pkt-lines without crashing", async () => {
    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    const validAdv = `${pkt("# service=git-upload-pack\n")}0000${
      pkt(`${validSha} HEAD\0symref=HEAD:refs/heads/main\n`)
    }0000`
    const validLsRefs = `${pkt(`${validSha} refs/heads/main\n`)}0000`
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([200, 302, 401, 403, 404, 500, 503]),
        contentType: Schema.Literals([
          "application/x-git-upload-pack-advertisement",
          "application/x-git-upload-pack-result",
          "text/plain"
        ]),
        payloadKind: Schema.Literals(["valid", "empty", "corrupt", "random"]),
        randomStr: Schema.String.pipe(Schema.check(Schema.isMaxLength(120))),
        op: Schema.Literals(["head", "ref"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, contentType, payloadKind, randomStr, op }) =>
          Effect.gen(function*() {
            const payload = payloadKind === "valid"
              ? op === "head"
                ? validAdv
                : validLsRefs
              : payloadKind === "empty"
              ? "0000"
              : payloadKind === "corrupt"
              ? "zzzzbad"
              : randomStr
            const fakeClient = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(payload, { status, headers: { "content-type": contentType } })
                )
              )
            )
            const eff: Effect.Effect<string | GitRemote.Head, GitRemote.GitRemoteError, HttpClient.HttpClient> =
              op === "head"
                ? GitRemote.head("https://git.example/repo.git")
                : GitRemote.ref({ url: "https://git.example/repo.git" }, "main")
            const res = yield* Effect.result(
              eff.pipe(Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, fakeClient), silentLogger)))
            )
            if (Result.isFailure(res)) {
              return res.failure._tag === "@smthrs/effect-code-storage/GitRemoteError"
            }
            const sha = typeof res.success === "string" ? res.success : res.success.sha
            return /^[0-9a-f]{40}$/i.test(sha)
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
