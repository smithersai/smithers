import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Redacted, type Scope, Stream } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as HttpRecording from "../src/HttpRecording.ts"

// A real service on a loopback port. It counts what reaches it, so replay can
// prove it never does.
const LIVE_TOKEN = "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"

interface Service {
  readonly url: string
  readonly hits: () => number
  readonly close: () => Promise<void>
}

const serve = (): Promise<Service> =>
  new Promise((done) => {
    let hits = 0
    let counter = 0
    const server: Server = createServer((request, response) => {
      hits += 1
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8")
        if (request.url?.startsWith("/counter") && request.method === "POST") counter += Number(JSON.parse(body).by)
        if (request.url === "/empty") {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(request.url === "/missing" ? 404 : 200, {
          "content-type": "application/json",
          "set-cookie": `session=${LIVE_TOKEN}`,
          "x-github-request-id": "ABCD:1234",
          link: "<http://127.0.0.1/next?page=2>; rel=\"next\"",
          location: `http://127.0.0.1/callback?page=1&code=${LIVE_TOKEN}`
        })
        response.end(JSON.stringify({
          path: request.url,
          counter,
          echoed: request.headers.authorization === `Bearer ${LIVE_TOKEN}`,
          token: LIVE_TOKEN,
          note: `install with ${LIVE_TOKEN} please`,
          nested: { access_token: "opaque-but-named", count: 3 },
          list: [LIVE_TOKEN, 1]
        }))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      done({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise((closed) => server.close(() => closed()))
      })
    })
  })

const withService = <A, E>(use: (service: Service) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.acquireRelease(Effect.promise(serve), (service) => Effect.promise(service.close)).pipe(
    Effect.flatMap(use),
    Effect.scoped
  )

const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined
  const found = Cause.findDefect(exit.cause)
  return found._tag === "Success" ? found.success : undefined
}

const directory = () => mkdtempSync(join(tmpdir(), "http-recording-"))

const live = HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))

const authorized = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, HttpClientRequest.bearerToken(LIVE_TOKEN))

// The calls a test makes: a read, a write, the same read again, a 404 and a 204.
const session = (client: HttpClient.HttpClient, base: string) =>
  Effect.gen(function*() {
    const read = (path: string) =>
      client.get(`${base}${path}`).pipe(Effect.flatMap((response) =>
        Effect.map(response.text, (text) => ({ status: response.status, body: text === "" ? null : JSON.parse(text) }))
      ))
    const before = yield* read("/counter?access_token=" + LIVE_TOKEN)
    const written = yield* client.execute(
      HttpClientRequest.post(`${base}/counter`).pipe(HttpClientRequest.bodyJsonUnsafe({ by: 2 }))
    )
    const after = yield* read("/counter?access_token=" + LIVE_TOKEN)
    const missing = yield* read("/missing")
    const empty = yield* read("/empty")
    return { before, written: written.status, after, missing, empty }
  })

describe("HttpRecording", () => {
  it.live("records a run with no credential, then replays it without the network", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "nested", "run.json")
        const client = yield* live
        const recorded = yield* Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, {
            live: authorized(client),
            secrets: [Redacted.make(LIVE_TOKEN)]
          })
          return yield* session(recorder, service.url)
        }))
        // The code under test saw the live answers, credentials included.
        expect(recorded.before.body).toMatchObject({ counter: 0, echoed: true, token: LIVE_TOKEN })
        expect(recorded.after.body.counter).toBe(2)
        const hits = service.hits()
        expect(hits).toBe(5)

        const text = readFileSync(path, "utf8")
        expect(text).not.toContain(LIVE_TOKEN)
        expect(text).not.toContain("opaque-but-named")
        expect(text).not.toContain("set-cookie")
        expect(text).not.toContain("x-github-request-id")
        expect(text).not.toMatch(/authorization/i)
        expect(HttpRecording.scan(text)).toEqual([])
        expect(text).toContain("\"link\"")
        expect(text).toContain("callback?page=1&code=%5BREDACTED%5D")

        const replayed = yield* Effect.scoped(Effect.gen(function*() {
          const replayer = yield* HttpRecording.make({ mode: "replay", path })
          return yield* session(replayer, service.url)
        }))
        expect(service.hits()).toBe(hits)
        expect(replayed.before.body.counter).toBe(0)
        expect(replayed.after.body.counter).toBe(2)
        expect(replayed.before.body.token).toBe("[REDACTED]")
        expect(replayed.before.body.nested).toEqual({ access_token: "[REDACTED]", count: 3 })
        expect(replayed.written).toBe(200)
        expect(replayed.missing.status).toBe(404)
        expect(replayed.empty).toEqual({ status: 204, body: null })
      })
    ))

  it.live("replay refuses a request the recording does not hold, or holds fewer times", () =>
    Effect.gen(function*() {
      const recording: HttpRecording.Recording = {
        exchanges: [{
          request: { method: "GET", url: "https://api.example.test/one" },
          response: { status: 200, headers: { "content-type": "application/json" }, body: { n: 1 } }
        }]
      }
      const client = HttpRecording.replay(recording)
      expect(client.remaining()).toBe(1)
      const first = yield* client.get("https://api.example.test/one").pipe(Effect.flatMap((response) => response.json))
      expect(first).toEqual({ n: 1 })
      expect(client.remaining()).toBe(0)
      const again = yield* Effect.exit(client.get("https://api.example.test/one"))
      const other = yield* Effect.exit(client.post("https://api.example.test/one"))
      for (const [exit, recorded] of [[again, 1], [other, 0]] as const) {
        const defect = defectOf(exit)
        expect(defect).toBeInstanceOf(HttpRecording.UnrecordedRequestError)
        expect((defect as HttpRecording.UnrecordedRequestError).recorded).toBe(recorded)
      }
    }))

  it.live("replay keys a text body and answers a text response; a streamed body cannot be keyed", () =>
    Effect.gen(function*() {
      const recording: HttpRecording.Recording = {
        exchanges: [{
          request: { method: "POST", url: "https://api.example.test/text", body: "plain words" },
          response: { status: 200, headers: { "content-type": "text/plain" }, body: "not json {" }
        }]
      }
      const client = HttpRecording.replay(recording)
      const raw = HttpClientRequest.post("https://api.example.test/text").pipe(
        HttpClientRequest.setBody(HttpBody.raw("plain words"))
      )
      const response = yield* client.execute(raw)
      expect(yield* response.text).toBe("not json {")
      const streamed = HttpClientRequest.post("https://api.example.test/text").pipe(
        HttpClientRequest.setBody(HttpBody.stream(Stream.make(new Uint8Array([1]))))
      )
      const defect = defectOf(yield* Effect.exit(client.execute(streamed)))
      expect(String((defect as Error).message)).toContain("cannot key a Stream request body")
      const binary = HttpClientRequest.post("https://api.example.test/text").pipe(
        HttpClientRequest.setBody(HttpBody.raw(new Uint8Array([1])))
      )
      expect(String((defectOf(yield* Effect.exit(client.execute(binary))) as Error).message)).toContain(
        "cannot key a Raw request body"
      )
      const missing = defectOf(yield* Effect.exit(client.get("https://api.example.test/text")))
      expect((missing as Error).message).toBe(
        "No recorded answer left for GET https://api.example.test/text (0 recorded). Record the test again."
      )
    }))

  it.live("normalize keys a run-to-run value out of the request on both sides", () =>
    Effect.gen(function*() {
      const normalize = (request: HttpRecording.RecordedRequest): HttpRecording.RecordedRequest => ({
        ...request,
        url: request.url.replace(/run-\d+/, "run-N")
      })
      const recording: HttpRecording.Recording = {
        exchanges: [{
          request: { method: "GET", url: "https://api.example.test/run-N" },
          response: { status: 200, headers: {}, body: "ok" }
        }]
      }
      const response = yield* HttpRecording.replay(recording, { normalize }).get("https://api.example.test/run-1789")
      expect(yield* response.text).toBe("ok")
    }))

  it.live("a failed run writes nothing and keeps the previous recording", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "kept.json")
        writeFileSync(path, "{\"exchanges\":[]}\n")
        const client = yield* live
        const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, { live: client })
          yield* recorder.get(`${service.url}/counter`)
          return yield* Effect.fail("the test failed")
        })))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(service.hits()).toBe(1)
        expect(readFileSync(path, "utf8")).toBe("{\"exchanges\":[]}\n")
      })
    ))

  it.live("a recording that still holds a credential is refused and not written", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "refused.json")
        const client = yield* live
        // normalize runs after scrubbing, so it can put a credential back; the final scan still refuses it.
        const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, {
            live: client,
            normalize: (request) => ({ ...request, url: `${request.url}#${LIVE_TOKEN}` })
          })
          yield* recorder.get(`${service.url}/counter`)
        })))
        expect(Exit.isFailure(exit)).toBe(true)
        const defect = defectOf(exit)
        expect(defect).toBeInstanceOf(HttpRecording.CredentialInRecordingError)
        expect((defect as HttpRecording.CredentialInRecordingError).rules).toContain("github-token")
        expect(String((defect as Error).message)).not.toContain(LIVE_TOKEN)
        expect(existsSync(path)).toBe(false)
      })
    ))

  it.effect("encode refuses a named live secret that matches no known shape", () =>
    Effect.gen(function*() {
      const secret = "plain-opaque-session-value"
      const exchange: HttpRecording.Exchange = {
        request: { method: "GET", url: "https://api.example.test/" },
        response: { status: 200, headers: {}, body: `value ${secret}` }
      }
      const refused = yield* Effect.flip(HttpRecording.encode("x.json", [exchange], [secret]))
      expect(refused.rules).toEqual(["live-secret"])
      const scrubbed = HttpRecording.scrubExchange(exchange, { secrets: [secret] })
      expect(yield* HttpRecording.encode("x.json", [scrubbed], [secret])).not.toContain(secret)
    }))

  it.effect("scan names each credential shape and passes placeholders", () =>
    Effect.sync(() => {
      expect(HttpRecording.scan(`{"a":"${LIVE_TOKEN}"}`)).toEqual(["github-token"])
      expect(HttpRecording.scan("Authorization: Bearer abcdefghijk")).toEqual(["bearer-token"])
      expect(HttpRecording.scan("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toContain("jwt")
      expect(HttpRecording.scan("AKIAABCDEFGHIJKLMNOP")).toEqual(["aws-access-key"])
      expect(HttpRecording.scan("\"token\": \"[REDACTED]\", \"sha\": \"" + "a".repeat(40) + "\"")).toEqual([])
    }))

  it.live("passthrough reaches the service and writes nothing", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "never.json")
        const client = yield* live
        const response = yield* HttpClient.get(`${service.url}/counter`).pipe(
          Effect.provide(HttpRecording.layer({ mode: "passthrough", path, live: client }))
        )
        expect(response.status).toBe(200)
        expect(service.hits()).toBe(1)
        expect(existsSync(path)).toBe(false)
      })
    ))

  it.live("a mode without its live client, or a replay without its file, is a defect", () =>
    Effect.gen(function*() {
      const path = join(directory(), "absent.json")
      for (const mode of ["passthrough", "record", "replay"] as const) {
        const exit = yield* Effect.exit(Effect.scoped(HttpRecording.make({ mode, path })))
        expect(defectOf(exit)).toBeInstanceOf(Error)
      }
      rmSync(path, { force: true })
    }))
})
