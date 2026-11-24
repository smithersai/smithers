import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Logger, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse, HttpServerRequest } from "effect/http"
import * as NodeCrypto from "node:crypto"
import * as Zlib from "node:zlib"
import { describe, expect, it } from "vitest"
import * as CodeStorage from "../src/CodeStorage.ts"
import * as GitProxy from "../src/GitProxy.ts"
import * as GitRemote from "../src/GitRemote.ts"
import * as Bounded from "../src/internal/bounded.ts"
import * as ScopedGit from "../src/internal/scopedGit.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const enc = new TextEncoder()
const testPem = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()

const pkt = (line: string): string => ScopedGit.packet(line)
const shaA = "0123456789abcdef0123456789abcdef01234567"
const shaB = "fedcba9876543210fedcba9876543210fedcba98"

describe("@smthrs/effect-code-storage Wave 10 deep fuzz", () => {
  it("bounded.readAtMost, bounded.readPackets, and scopedGit.negotiation enforce framing, caps, and chunk boundaries", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
        maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 120 })),
        mode: Schema.Literals([
          "validMulti",
          "stopEarlyPayload",
          "stopEarlyFlush",
          "badHexHeader",
          "shortHeaderLen",
          "truncatedBody",
          "invalidLimit"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chunkSize, maxBytes, mode }) =>
          Effect.gen(function*() {
            if (mode === "invalidLimit") {
              const e1 = yield* Effect.exit(Bounded.readAtMost(Stream.empty, -1))
              const e2 = yield* Effect.exit(Bounded.readPackets(Stream.empty, 1.5, () => true))
              return Exit.isFailure(e1) && Exit.isFailure(e2)
            }

            let raw: Uint8Array
            if (mode === "badHexHeader") {
              raw = enc.encode("ZZZZhello")
            } else if (mode === "shortHeaderLen") {
              raw = enc.encode("0002")
            } else {
              raw = enc.encode(`${pkt("alpha\n")}0000${pkt("beta\n")}${pkt("gamma\n")}0000`)
            }

            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < raw.length; i += chunkSize) {
              chunks.push(raw.subarray(i, i + chunkSize))
            }
            const stream = Stream.fromIterable(chunks)

            const atMost = yield* Bounded.readAtMost(stream, maxBytes)
            if (atMost.bytes.length > maxBytes) return false
            if (atMost.truncated !== (raw.length > maxBytes)) return false

            const delivered: Array<string | null> = []
            const cap = mode === "truncatedBody" ? Math.min(maxBytes, 7) : 256
            const res = yield* Bounded.readPackets(stream, cap, (payload) => {
              delivered.push(payload === null ? null : new TextDecoder().decode(payload))
              if (mode === "stopEarlyFlush" && payload === null) return false
              if (mode === "stopEarlyPayload" && payload !== null) return false
              return true
            })

            if (mode === "badHexHeader" || mode === "shortHeaderLen") {
              return res.invalid === true
            }
            if (mode === "validMulti") {
              return !res.invalid && !res.truncated && delivered.length === 5
            }
            if (mode === "stopEarlyPayload") {
              return !res.invalid && delivered.length === 1
            }
            if (mode === "stopEarlyFlush") {
              return !res.invalid && delivered.length === 2 && delivered[1] === null
            }
            return res.truncated === (raw.length > cap)
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    // Fuzz scopedGit.negotiation across every valid & invalid wire path
    const negArb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Literals([
          "validDone",
          "validCapsAndSecondWant",
          "validHavesStripped",
          "validDoubleFlush",
          "badHex",
          "sizeTooSmall",
          "truncatedPacket",
          "flushBeforeWant",
          "badUtf8",
          "wrongTip",
          "secondWantWithCaps",
          "badLineInHave",
          "trailingAfterEnd",
          "incompletePhase"
        ])
      })
    )
    const negReport = await Effect.runPromise(
      Fuzz.run(
        negArb,
        ({ variant }) =>
          Effect.sync(() => {
            const want1 = pkt(`want ${shaA} side-band-64k ofs-delta\n`)
            const want2 = pkt(`want ${shaA}\n`)
            const have1 = pkt(`have ${shaB}\n`)
            const done = pkt("done\n")
            let bytes: Uint8Array
            let expectValid = false
            switch (variant) {
              case "validDone":
                bytes = enc.encode(`${want1}0000${done}`)
                expectValid = true
                break
              case "validCapsAndSecondWant":
                bytes = enc.encode(`${want1}${want2}0000${done}`)
                expectValid = true
                break
              case "validHavesStripped":
                bytes = enc.encode(`${want1}0000${have1}${done}`)
                expectValid = true
                break
              case "validDoubleFlush":
                bytes = enc.encode(`${want1}00000000`)
                expectValid = true
                break
              case "badHex":
                bytes = enc.encode("XXXX")
                break
              case "sizeTooSmall":
                bytes = enc.encode("0004")
                break
              case "truncatedPacket":
                bytes = enc.encode("0010short")
                break
              case "flushBeforeWant":
                bytes = enc.encode("0000")
                break
              case "badUtf8": {
                const body = new Uint8Array([0x30, 0x30, 0x30, 0x36, 0xff, 0xfe])
                bytes = body
                break
              }
              case "wrongTip":
                bytes = enc.encode(`${pkt(`want ${shaB}\n`)}0000${done}`)
                break
              case "secondWantWithCaps":
                bytes = enc.encode(`${want1}${pkt(`want ${shaA} ofs-delta\n`)}0000${done}`)
                break
              case "badLineInHave":
                bytes = enc.encode(`${want1}0000${pkt("shallow " + shaA + "\n")}${done}`)
                break
              case "trailingAfterEnd":
                bytes = enc.encode(`${want1}0000${done}0000`)
                break
              case "incompletePhase":
                bytes = enc.encode(`${want1}0000`)
                break
            }
            const out = ScopedGit.negotiation(bytes, shaA)
            if (expectValid) {
              if (out === undefined) return false
              if (variant === "validHavesStripped" && out.includes("have ")) return false
              return true
            }
            return out === undefined
          }),
        { seed: seed + 1, executions }
      )
    )
    const negFail = Fuzz.formatReport(negReport)
    if (negFail !== undefined) throw new Error(negFail)
  }, 60_000)

  it("GitRemote.head, GitRemote.ref, and GitProxy.uploadPack cover every protocol, error, gzip, redirect, and stream-break path", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "headSymref",
          "headDetached",
          "headEmptyZeroSha",
          "headEmptyFlush",
          "headBadService",
          "headMissingFlush",
          "headBadUtf8",
          "headBadRefLine",
          "head404",
          "head503",
          "headRedirect",
          "headBadContentType",
          "headTransportError",
          "headStreamError",
          "headTooLarge",
          "headEofEarly",
          "refFoundAfterOther",
          "refNotFound",
          "refBadUtf8",
          "refBadLine",
          "refTooLongBranch",
          "ref403",
          "ref502",
          "refBadContentType",
          "refStreamError"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            const upstream: GitRemote.Upstream = {
              url: "https://git.example.com/org/repo/",
              authorization: Redacted.make("Bearer secret-tok")
            }
            const client = HttpClient.make((req) => {
              if (mode === "headTransportError") {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("down") })
                  })
                )
              }
              if (mode === "headStreamError" || mode === "refStreamError") {
                const s = new ReadableStream<Uint8Array>({
                  start(c) {
                    c.error(new Error("broken stream"))
                  }
                })
                const ct = mode === "headStreamError"
                  ? "application/x-git-upload-pack-advertisement"
                  : "application/x-git-upload-pack-result"
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(s, { status: 200, headers: { "content-type": ct } })))
              }
              switch (mode) {
                case "headSymref":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}0000${pkt(`${shaA} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`)}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headDetached":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}0000${pkt(`${shaA} HEAD\0multi_ack\n`)}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headEmptyZeroSha":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}0000${pkt(`${"0".repeat(40)} capabilities^{}\0\n`)}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headEmptyFlush":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}00000000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headBadService":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-receive-pack\n")}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headMissingFlush":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}${pkt("not-a-flush\n")}`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "headBadUtf8": {
                  const head1 = enc.encode(`${pkt("# service=git-upload-pack\n")}0000`)
                  const badPkt = new Uint8Array([0x30, 0x30, 0x30, 0x36, 0xff, 0xfe])
                  const out = new Uint8Array(head1.length + badPkt.length)
                  out.set(head1, 0)
                  out.set(badPkt, head1.length)
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(out, {
                    status: 200,
                    headers: { "content-type": "application/x-git-upload-pack-advertisement" }
                  })))
                }
                case "headBadRefLine":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}0000${pkt("garbage line\n")}`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "head404":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 404 })))
                case "head503":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 503 })))
                case "headRedirect":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 302, headers: { location: "https://evil.example" } })))
                case "headBadContentType":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 200, headers: { "content-type": "text/plain" } })))
                case "headTooLarge": {
                  const big = `${pkt("# service=git-upload-pack\n")}0000${"a".repeat(70_000)}`
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(big, {
                    status: 200,
                    headers: { "content-type": "application/x-git-upload-pack-advertisement" }
                  })))
                }
                case "headEofEarly":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("# service=git-upload-pack\n")}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } }
                  )))
                case "refFoundAfterOther":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt(`${shaB} refs/heads/other\n`)}${pkt(`${shaA} refs/heads/main\n`)}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }
                  )))
                case "refNotFound":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt(`${shaB} refs/heads/other\n`)}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }
                  )))
                case "refBadUtf8":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    new Uint8Array([0x30, 0x30, 0x30, 0x36, 0xff, 0xfe]),
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }
                  )))
                case "refBadLine":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
                    `${pkt("not-a-sha ref\n")}0000`,
                    { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }
                  )))
                case "ref403":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 403 })))
                case "ref502":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 502 })))
                case "refBadContentType":
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 200, headers: { "content-type": "text/html" } })))
                default:
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 200 })))
              }
            })

            const layer = Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), silentLogger)
            if (mode.startsWith("head")) {
              const r = yield* Effect.result(GitRemote.head(upstream)).pipe(Effect.provide(layer))
              if (mode === "headSymref") return Result.isSuccess(r) && r.success.sha === shaA && r.success.branch === "main"
              if (mode === "headDetached") return Result.isSuccess(r) && r.success.sha === shaA && r.success.branch === undefined
              if (!Result.isFailure(r)) return false
              // Access message getter to exercise formatting with/without status
              return r.failure.message.startsWith("git remote: ")
            } else {
              const branch = mode === "refTooLongBranch" ? "b".repeat(70_000) : "main"
              const r = yield* Effect.result(GitRemote.ref(upstream, branch)).pipe(Effect.provide(layer))
              if (mode === "refFoundAfterOther") return Result.isSuccess(r) && r.success === shaA
              if (!Result.isFailure(r)) return false
              return r.failure.message.startsWith("git remote: ")
            }
          }),
        { seed: seed + 2, executions: Math.min(executions, 120) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    // GitProxy: classify unparseable URL, scoped info-refs, scoped gzip POST, transport error, redirect, 500, broken stream
    expect(GitProxy.classify("GET", "http://[::1")).toBeUndefined()
    expect(GitProxy.classify("GET", "/repo/info/refs?service=git-upload-pack")).toBe("info-refs")
    expect(GitProxy.classify("GET", "/repo/info/refs?service=git-upload-pack&service=other")).toBeUndefined()

    const upstream: GitRemote.Upstream = {
      url: "https://git.example.com/org/repo",
      authorization: Redacted.make("Bearer proxy-tok")
    }

    const proxyCases = [
      "scopedInfoOk",
      "scopedInfoTipFail",
      "scopedPostGzipOk",
      "scopedPostBadGzip",
      "unscopedTransportFail",
      "unscopedRedirect",
      "unscopedStatus500",
      "unscopedBrokenStream"
    ] as const

    for (const c of proxyCases) {
      const client = HttpClient.make((req) => {
        if (c.startsWith("scoped") && req.headers["git-protocol"] === "version=2") {
          if (c === "scopedInfoTipFail") {
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 404 })))
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(
            `${pkt(`${shaA} refs/heads/main\n`)}0000`,
            { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } }
          )))
        }
        if (c === "unscopedTransportFail") {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request: req, cause: new Error("net") })
            })
          )
        }
        if (c === "unscopedRedirect") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 301, headers: { location: "https://other" } })))
        }
        if (c === "unscopedStatus500") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("err", { status: 500, headers: { "content-type": "text/plain", "cache-control": "no-cache" } })))
        }
        if (c === "unscopedBrokenStream") {
          const s = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.error(new Error("cut"))
            }
          })
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(s, { status: 200, headers: { "content-type": "application/octet-stream" } })))
        }
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("PACK", { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } })))
      })

      const webReq = (() => {
        if (c === "scopedInfoOk" || c === "scopedInfoTipFail") {
          return new Request("http://proxy/repo/info/refs?service=git-upload-pack", { method: "GET" })
        }
        if (c === "scopedPostGzipOk") {
          const gz = Zlib.gzipSync(Buffer.from(`${pkt(`want ${shaA}\n`)}0000${pkt("done\n")}`))
          return new Request("http://proxy/repo/git-upload-pack", {
            method: "POST",
            headers: { "content-encoding": "gzip", "content-type": "application/x-git-upload-pack-request" },
            body: gz
          })
        }
        if (c === "scopedPostBadGzip") {
          return new Request("http://proxy/repo/git-upload-pack", {
            method: "POST",
            headers: { "content-encoding": "x-gzip" },
            body: new Uint8Array([0x01, 0x02, 0x03])
          })
        }
        return new Request("http://proxy/repo/info/refs?service=git-upload-pack", {
          method: "GET",
          headers: { accept: "*/*", "git-protocol": "version=2" }
        })
      })()

      const resp = await Effect.runPromise(
        GitProxy.uploadPack(
          HttpServerRequest.fromWeb(webReq),
          upstream,
          c.startsWith("scoped") ? "main" : undefined
        ).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), silentLogger)))
      )
      if (c === "scopedInfoOk" || c === "scopedPostGzipOk") expect(resp.status).toBe(200)
      else if (c === "scopedPostBadGzip") expect(resp.status).toBe(403)
      else if (c === "unscopedStatus500") expect(resp.status).toBe(500)
      else if (c === "unscopedBrokenStream") {
        expect(resp.status).toBe(200)
        // Drain body stream to trigger Stream.onExit broken outcome
        if (resp.body._tag === "Stream") {
          const exit = await Effect.runPromise(Effect.exit(Stream.runDrain(resp.body.stream)))
          expect(Exit.isFailure(exit)).toBe(true)
        }
      } else expect(resp.status).toBe(502)
    }
  }, 60_000)

  it("CodeStorage exercises layerConfig, error messages, isTransient, listCommits/listBranches/listTags/listFiles/readFile, and edge error responses", async () => {
    // Error messages & isTransient
    const e1 = new CodeStorage.CodeStorageError({ operation: "readFile", code: "rate_limited", status: 429, unknownCode: "custom_err" })
    expect(e1.message).toContain("unknown code custom_err")
    expect(CodeStorage.isTransient(e1)).toBe(true)
    const e2 = new CodeStorage.CodeStorageError({ operation: "readFile", code: "transport" })
    expect(e2.message).toBe("Code Storage readFile failed: transport")
    expect(CodeStorage.isTransient(e2)).toBe(true)
    const e3 = new CodeStorage.CodeStorageError({ operation: "readFile", code: "not_found", status: 502, unknownCode: "BAD CODE!" })
    expect(e3.message).not.toContain("BAD CODE")
    expect(CodeStorage.isTransient(e3)).toBe(true)
    const e4 = new CodeStorage.CodeStorageError({ operation: "readFile", code: "not_found", status: 404 })
    expect(CodeStorage.isTransient(e4)).toBe(false)
    expect(new CodeStorage.CodeStorageInvalidRepository().message).toContain("invalid repository name")

    const client = HttpClient.make((req) => {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/commits")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({
          commits: [{
            sha: shaA,
            parent_shas: [shaB],
            message: "init",
            author_name: "Will",
            author_email: "will@example.com",
            date: "2026-11-24T00:00:00Z"
          }],
          next_cursor: "cur1",
          has_more: true
        }), { status: 200, headers: { "content-type": "application/json" } })))
      }
      if (url.pathname.endsWith("/branches")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({
          branches: [{ name: "main", head_sha: shaA, created_at: "2026-11-24T00:00:00Z" }],
          
          has_more: false
        }), { status: 200, headers: { "content-type": "application/json" } })))
      }
      if (url.pathname.endsWith("/tags")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({
          tags: [{ name: "v1.0.0", sha: shaA }],
          has_more: false
        }), { status: 200, headers: { "content-type": "application/json" } })))
      }
      if (url.pathname.includes("/weird-status")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ error: "teapot_err" }), { status: 418 })))
      }
      if (url.pathname.includes("/no-body-err")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("plain", { status: 418 })))
      }
      if (url.pathname.includes("/redirect-err")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 302, headers: { location: "https://x" } })))
      }
      if (url.pathname.includes("/bad-json")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{bad", { status: 200 })))
      }
      if (url.pathname.includes("/bad-schema")) {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ wrong: 1 }), { status: 200 })))
      }
      if (url.pathname.includes("/transport-fail")) {
        return Effect.fail(new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req, cause: new Error("drop") })
        }))
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({}), { status: 200 })))
    })

    const envProvider = ConfigProvider.fromEnv({
      env: {
        CODE_STORAGE_ORG: "acme",
        CODE_STORAGE_KEY: testPem,
        CODE_STORAGE_API_URL: "https://api.acme.example",
        CODE_STORAGE_GIT_URL: "https://git.acme.example"
      }
    })
    const layer = CodeStorage.CodeStorage.layerConfig.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(ConfigProvider.layer(envProvider)),
      Layer.provide(silentLogger)
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const cs = yield* CodeStorage.CodeStorage
        const commits = yield* cs.listCommits("org/repo", { ref: "main", namespace: "ephemeral", path: "src", cursor: "c0", limit: 10 })
        expect(commits.commits.length).toBe(1)
        expect(commits.nextCursor).toBe("cur1")

        const branches = yield* cs.listBranches("org/repo", { namespace: "default", cursor: "c0", limit: 10 })
        expect(branches.branches.length).toBe(1)

        const tags = yield* cs.listTags("org/repo", { cursor: "c0", limit: 5 })
        expect(tags.tags.length).toBe(1)

        // Error classification paths
        for (const badRepo of ["org/weird-status", "org/no-body-err", "org/redirect-err", "org/bad-json", "org/bad-schema", "org/transport-fail"]) {
          const r = yield* Effect.result(cs.listFiles(badRepo))
          expect(Result.isFailure(r)).toBe(true)
        }

        // Invalid repo name defect
        const badRemote = yield* Effect.exit(cs.gitRemote("org/../escape"))
        expect(Exit.isFailure(badRemote)).toBe(true)
      }).pipe(Effect.provide(layer))
    )
  }, 60_000)
})
