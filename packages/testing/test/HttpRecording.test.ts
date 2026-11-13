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

const serve = (reply?: string): Promise<Service> =>
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
        if (request.url === "/short-secret") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ note: "hunter2" }))
          return
        }
        if (request.url?.startsWith("/location?")) {
          const location = new URL(request.url, "http://localhost").searchParams.get("value")!
          response.writeHead(201, { "content-type": "application/json", location })
          response.end("{\"created\":true}")
          return
        }
        if (request.url?.startsWith("/body?")) {
          const params = new URL(request.url, "http://localhost").searchParams
          const contentType = params.get("content-type")
          response.writeHead(200, contentType === null ? {} : { "content-type": contentType })
          response.end(Buffer.from(params.get("hex")!, "hex"))
          return
        }
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
        response.end(
          reply ?? JSON.stringify({
            path: request.url,
            counter,
            echoed: request.headers.authorization === `Bearer ${LIVE_TOKEN}`,
            token: LIVE_TOKEN,
            note: `install with ${LIVE_TOKEN} please`,
            nested: { access_token: "opaque-but-named", count: 3 },
            list: [LIVE_TOKEN, 1]
          })
        )
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

const withService = <A, E>(use: (service: Service) => Effect.Effect<A, E, Scope.Scope>, reply?: string) =>
  Effect.acquireRelease(Effect.promise(() => serve(reply)), (service) => Effect.promise(service.close)).pipe(
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
    const before = yield* read("/counter?state=open&access_token=" + LIVE_TOKEN)
    const written = yield* client.execute(
      HttpClientRequest.post(`${base}/counter`).pipe(HttpClientRequest.bodyJsonUnsafe({ by: 2 }))
    )
    const after = yield* read("/counter?state=open&access_token=" + LIVE_TOKEN)
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
            secrets: [Redacted.make(LIVE_TOKEN)],
            label: "run-1789"
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
        // A query parameter that names no credential, such as GitHub's issue `state`, is kept.
        expect(text).toContain("/counter?state=open&access_token=%5BREDACTED%5D")
        // One exchange per line, between the opening and closing lines.
        expect(text.split("\n")).toHaveLength(5 + 3)
        expect((yield* HttpRecording.load(path)).label).toBe("run-1789")

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

  it.live("short named secrets are removed before a recording is written", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "short-secret.json")
        const client = yield* live
        const seen = yield* Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, { live: client, secrets: [Redacted.make("hunter2")] })
          return yield* recorder.get(`${service.url}/short-secret`).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(seen).toEqual({ note: "hunter2" })
        expect(service.hits()).toBe(1)
        expect(readFileSync(path, "utf8")).not.toContain("hunter2")
        expect((yield* HttpRecording.load(path)).exchanges[0]?.response.body).toEqual({ note: "[REDACTED]" })
      })
    ))

  it.live("records relative Location headers and replays their scrubbed URI references", () =>
    withService((service) =>
      Effect.gen(function*() {
        const client = yield* live
        const locations = [
          [
            "https://person:private@api.example.test/item?code=opaque&page=2",
            "https://api.example.test/item?code=%5BREDACTED%5D&page=2"
          ],
          [
            "//person:private@api.example.test/item?code=opaque#part",
            "//api.example.test/item?code=%5BREDACTED%5D#part"
          ],
          ["/repos/o/r/issues/5?code=opaque&page=2", "/repos/o/r/issues/5?code=%5BREDACTED%5D&page=2"],
          ["../issues/5?sig=opaque#detail", "../issues/5?sig=%5BREDACTED%5D#detail"],
          ["./issues/5?code=one&code=two&state=open", "./issues/5?code=%5BREDACTED%5D&state=open"],
          ["issues/5?code=opaque", "issues/5?code=%5BREDACTED%5D"],
          ["?code=opaque&state=open", "?code=%5BREDACTED%5D&state=open"],
          ["\\\\person:private@api.example.test/item?code=opaque", "//api.example.test/item?code=%5BREDACTED%5D"],
          ["/\\person:private@api.example.test/item", "//api.example.test/item"],
          ["\\/person:private@api.example.test/item", "//api.example.test/item"],
          ["h\tttps://person:private@api.example.test/item", "https://api.example.test/item"],
          ["#detail?code=opaque", "#detail?code=opaque"],
          ["?", "?"],
          ["", ""],
          ["http://[invalid?code=opaque", "[REDACTED]"]
        ] as const
        for (const [location, expected] of locations) {
          const path = join(directory(), "location.json")
          const url = `${service.url}/location?value=${encodeURIComponent(location)}`
          yield* Effect.scoped(Effect.gen(function*() {
            const recorder = yield* HttpRecording.record(path, { live: client })
            const response = yield* recorder.get(url)
            expect(response.status).toBe(201)
            expect(response.headers.location).toBe(location)
            expect(yield* response.json).toEqual({ created: true })
          }))
          const recording = yield* HttpRecording.load(path)
          expect(recording.exchanges[0]!.response.headers.location, location).toBe(expected)
          const replayed = yield* HttpRecording.replay(recording).get(url)
          expect(replayed.headers.location, location).toBe(expected)
          expect(yield* replayed.json).toEqual({ created: true })
        }
        expect(service.hits()).toBe(locations.length)
      })
    ))

  it.effect("normalizes URL-parser whitespace without retaining authority credentials", () =>
    Effect.sync(() => {
      for (
        const [location, expected] of [
          [" \u0000//person:private@api.example.test/item\u001F ", "//api.example.test/item"],
          [" \t\r\n ", ""],
          ["\u00A0/item", "\u00A0/item"]
        ]
      ) {
        const scrubbed = HttpRecording.scrubExchange({
          request: { method: "GET", url: "https://api.example.test/" },
          response: { status: 201, headers: { location: location! }, body: "" }
        })
        expect(scrubbed.response.headers.location).toBe(expected)
      }
    }))

  it.live("refuses binary or invalid UTF-8 responses without replacing a recording", () =>
    withService((service) =>
      Effect.gen(function*() {
        const client = yield* live
        const bodies = [
          ["application/octet-stream", "616263"],
          ["image/png", "fffefd00"],
          ["text/plain; charset=utf-8", "fffe"],
          ["application/json", "c328"],
          [undefined, "e282"]
        ] as const
        for (const [contentType, hex] of bodies) {
          const path = join(directory(), "binary.json")
          const previous = "{\"exchanges\":[]}\n"
          if (contentType !== undefined) writeFileSync(path, previous)
          const query = new URLSearchParams({ hex })
          if (contentType !== undefined) query.set("content-type", contentType)
          const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
            const recorder = yield* HttpRecording.record(path, { live: client })
            yield* recorder.get(`${service.url}/body?${query}`)
          })))
          const defect = defectOf(exit)
          expect(defect).toBeInstanceOf(Error)
          expect((defect as Error).message).toContain("HttpRecording cannot record")
          expect((defect as Error).message).toContain(contentType ?? "unspecified content type")
          if (contentType === undefined) expect(existsSync(path)).toBe(false)
          else expect(readFileSync(path, "utf8")).toBe(previous)
        }
        expect(service.hits()).toBe(bodies.length)
      })
    ))

  it.live("records and replays UTF-8 text and JSON without losing bytes", () =>
    withService((service) =>
      Effect.gen(function*() {
        const client = yield* live
        const bodies = [
          ["text/plain; charset=utf-8", "café ☕"],
          ["application/json; charset=utf-8", "{\"message\":\"café ☕\"}"],
          ["Application/Problem+JSON", "{\"message\":\"café ☕\"}"],
          [undefined, "café ☕"],
          ["text/plain", "\uFEFFcafé ☕"],
          ["application/octet-stream", ""]
        ] as const
        for (const [contentType, text] of bodies) {
          const path = join(directory(), "text.json")
          const bytes = Buffer.from(text, "utf8")
          const query = new URLSearchParams({ hex: bytes.toString("hex") })
          if (contentType !== undefined) query.set("content-type", contentType)
          const url = `${service.url}/body?${query}`
          const recorded = yield* Effect.scoped(Effect.gen(function*() {
            const recorder = yield* HttpRecording.record(path, { live: client })
            const response = yield* recorder.get(url)
            return new Uint8Array(yield* response.arrayBuffer)
          }))
          expect(recorded).toEqual(new Uint8Array(bytes))
          const recording = yield* HttpRecording.load(path)
          const response = yield* HttpRecording.replay(recording).get(url)
          expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(new Uint8Array(bytes))
        }
        expect(service.hits()).toBe(bodies.length)
      })
    ))

  it.live("a top-level JSON string decodes while recording and after loading a replay", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "string.json")
        const client = yield* live
        const recorded = yield* Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, { live: client })
          return yield* recorder.get(service.url).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(recorded).toBe("ok")
        const replayed = yield* Effect.scoped(Effect.gen(function*() {
          const replayer = yield* HttpRecording.make({ mode: "replay", path })
          return yield* replayer.get(service.url).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(replayed).toBe("ok")
        expect(service.hits()).toBe(1)
      }), "\"ok\""))

  for (
    const body of [
      "\"ok\"",
      "\"\"",
      "\"line\\nquote\\\"slash\\\\end\"",
      " \r\n \"ok\" \t",
      "1.0",
      "1e3",
      "-0",
      "9007199254740993",
      "1e400",
      " true ",
      " false ",
      " null ",
      "",
      "not json {"
    ]
  ) {
    for (const identityPrune of [false, true]) {
      it.live(`record and replay preserve scalar response text ${JSON.stringify(body)}${identityPrune ? " with identity prune" : ""}`, () =>
        withService((service) =>
          Effect.gen(function*() {
            const path = join(directory(), "scalar.json")
            const client = yield* live
            const recorded = yield* Effect.scoped(Effect.gen(function*() {
              const recorder = yield* HttpRecording.record(path, {
                live: client,
                ...(identityPrune ? { prune: (value: unknown) => value } : {})
              })
              return yield* recorder.get(service.url).pipe(Effect.flatMap((response) => response.text))
            }))
            expect(recorded).toBe(body)
            expect((yield* HttpRecording.load(path)).exchanges[0]?.response.body).toBe(body)
            const replayed = yield* Effect.scoped(Effect.gen(function*() {
              const replayer = yield* HttpRecording.make({ mode: "replay", path })
              return yield* replayer.get(service.url).pipe(Effect.flatMap((response) => response.text))
            }))
            expect(replayed).toBe(body)
            expect(service.hits()).toBe(1)
          }), body))
    }
  }

  for (
    const [label, body] of [
      ["raw token", LIVE_TOKEN],
      ["escaped JSON token", JSON.stringify(LIVE_TOKEN).replace("g", "\\u0067")],
      ["raw named secret", "opaque\"session\\value"],
      ["JSON named secret", JSON.stringify("opaque\"session\\value")]
    ] as const
  ) {
    it.live(
      "scalar response text scrubs credentials before replay: " + label,
      () =>
        withService((service) =>
          Effect.gen(function*() {
            const path = join(directory(), "scrubbed-scalar.json")
            const client = yield* live
            const recorded = yield* Effect.scoped(Effect.gen(function*() {
              const recorder = yield* HttpRecording.record(path, {
                live: client,
                secrets: ["opaque\"session\\value"]
              })
              return yield* recorder.get(service.url).pipe(Effect.flatMap((response) => response.text))
            }))
            expect(recorded).toBe(body)
            expect(HttpRecording.scan(readFileSync(path, "utf8"))).toEqual([])
            const replayed = yield* Effect.scoped(Effect.gen(function*() {
              const replayer = yield* HttpRecording.make({ mode: "replay", path })
              const response = yield* replayer.get(service.url)
              return yield* (body.startsWith("\"") ? response.json : response.text)
            }))
            expect(replayed).toBe("[REDACTED]")
            expect(service.hits()).toBe(1)
          }), body)
    )
  }

  it.live("an identity prune keeps a top-level JSON string readable on replay", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "identity-prune.json")
        const client = yield* live
        const recorded = yield* Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, { live: client, prune: (body) => body })
          return yield* recorder.get(service.url).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(recorded).toBe("ok")
        const replayed = yield* Effect.scoped(Effect.gen(function*() {
          const replayer = yield* HttpRecording.make({ mode: "replay", path })
          return yield* replayer.get(service.url).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(replayed).toBe("ok")
        expect(service.hits()).toBe(1)
      }), "\"ok\""))

  for (
    const [label, wire, prune, recordedValue, replayedValue, json] of [
      ["JSON string", JSON.stringify(LIVE_TOKEN).replace("g", "\\u0067"), () => "safe", "safe", "safe", true],
      [
        "JSON object to string",
        "{\"name\":\"safe\"}",
        (body: unknown) => (body as { name: string }).name,
        "safe",
        "safe",
        true
      ],
      ["plain text", "discarded text", () => "safe", "safe", "safe", false],
      ["JSON string to number", "\"old\"", () => 3, 3, 3, true],
      ["signed zero replacement", "-0", () => 0, 0, 0, true],
      ["plain text to JSON", "discarded text", () => ({ safe: true }), { safe: true }, { safe: true }, true],
      ["scrubbed JSON string", "{\"name\":\"unused\"}", () => LIVE_TOKEN, LIVE_TOKEN, "[REDACTED]", true]
    ] as const
  ) {
    it.live(
      "a prune replacement has the same encoding while recording and replaying: " + label,
      () =>
        withService((service) =>
          Effect.gen(function*() {
            const path = join(directory(), "replaced-scalar.json")
            const client = yield* live
            const recorded = yield* Effect.scoped(Effect.gen(function*() {
              const recorder = yield* HttpRecording.record(path, { live: client, prune })
              const response = yield* recorder.get(service.url)
              return yield* (json ? response.json : response.text)
            }))
            expect(recorded).toEqual(recordedValue)
            expect(HttpRecording.scan(readFileSync(path, "utf8"))).toEqual([])
            const response = yield* HttpRecording.replay(yield* HttpRecording.load(path)).get(service.url)
            expect(yield* (json ? response.json : response.text)).toEqual(replayedValue)
            expect(service.hits()).toBe(1)
          }), wire)
    )
  }

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

  it.live("prune shapes what the code sees while recording and what the recording holds", () =>
    withService((service) =>
      Effect.gen(function*() {
        const path = join(directory(), "pruned.json")
        const client = yield* live
        const seen = yield* Effect.scoped(Effect.gen(function*() {
          const recorder = yield* HttpRecording.record(path, {
            live: client,
            prune: (body, request) =>
              typeof body === "object" && body !== null && request.method === "GET"
                ? { path: (body as { path: unknown }).path }
                : body
          })
          const pruned = yield* recorder.get(`${service.url}/counter`).pipe(Effect.flatMap((response) => response.json))
          const empty = yield* recorder.get(`${service.url}/empty`).pipe(Effect.flatMap((response) => response.text))
          return { pruned, empty }
        }))
        expect(seen).toEqual({ pruned: { path: "/counter" }, empty: "" })
        const replayed = yield* Effect.scoped(Effect.gen(function*() {
          const replayer = yield* HttpRecording.make({ mode: "replay", path })
          return yield* replayer.get(`${service.url}/counter`).pipe(Effect.flatMap((response) => response.json))
        }))
        expect(replayed).toEqual({ path: "/counter" })
      })
    ))

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
      const refused = yield* Effect.flip(HttpRecording.encode("x.json", { exchanges: [exchange] }, [secret]))
      expect(refused.rules).toEqual(["live-secret"])
      const scrubbed = HttpRecording.scrubExchange(exchange, { secrets: [secret] })
      expect(yield* HttpRecording.encode("x.json", { exchanges: [scrubbed] }, [secret])).not.toContain(secret)
    }))

  for (const value of ["!", "1234", "hunter2", "12345678"]) {
    for (const wrapped of [false, true]) {
      it.effect(`scrubs and guards a ${value.length}-character ${wrapped ? "Redacted" : "string"} secret`, () =>
        Effect.gen(function*() {
          const secrets = [wrapped ? Redacted.make(value) : value]
          const exchange: HttpRecording.Exchange = {
            request: {
              method: "POST",
              url: `https://api.example.test/submit?note=${value}`,
              body: { note: `before ${value} after ${value}` }
            },
            response: {
              status: 200,
              headers: { "retry-after": value },
              body: { note: value, nested: [value, { note: `before ${value} after` }], count: 1, empty: null }
            }
          }
          const refused = yield* Effect.flip(HttpRecording.encode("x.json", { exchanges: [exchange] }, secrets))
          expect(refused.rules).toEqual(["live-secret"])
          expect(refused.message).not.toContain(value)

          const scrubbed = HttpRecording.scrubExchange(exchange, { secrets })
          expect(scrubbed.request).toEqual({
            method: "POST",
            url: "https://api.example.test/submit?note=[REDACTED]",
            body: { note: "before [REDACTED] after [REDACTED]" }
          })
          expect(scrubbed.response).toEqual({
            status: 200,
            headers: { "retry-after": "[REDACTED]" },
            body: {
              note: "[REDACTED]",
              nested: ["[REDACTED]", { note: "before [REDACTED] after" }],
              count: 1,
              empty: null
            }
          })
          expect(yield* HttpRecording.encode("x.json", { exchanges: [scrubbed] }, secrets)).not.toContain(value)
        }))
    }
  }

  it.effect("empty named secrets leave recordings unchanged", () =>
    Effect.gen(function*() {
      const exchange: HttpRecording.Exchange = {
        request: { method: "GET", url: "https://api.example.test/" },
        response: { status: 200, headers: {}, body: { note: "ordinary text" } }
      }
      const secrets = ["", Redacted.make("")]
      expect(HttpRecording.scrubExchange(exchange, { secrets })).toEqual(exchange)
      expect(yield* HttpRecording.encode("x.json", { exchanges: [exchange] }, secrets)).toBe(
        yield* HttpRecording.encode("x.json", { exchanges: [exchange] }, undefined)
      )
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
