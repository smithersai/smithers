/**
 * The remote content store behind a cache handle: artifact upload before the
 * entry, verified restore into the local CAS, the bounded retry of busy or slow
 * exchanges, and which failures cost one entry versus the whole remote.
 *
 * The happy paths run against a real loopback HTTP server that implements the
 * `/ac` and `/cas` routes. Faults are server answers, or a `fetch` the handle
 * already accepts that answers with a body no real server sends.
 */
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CachedResult,
  type CacheStore,
  findMissingTimeoutLimit,
  openCache,
  remoteEntryLimit
} from "../src/Cache.ts"
import { chunkBytes } from "../src/internal/OutputCas.ts"

interface Exchange {
  readonly method: string
  readonly path: string
  readonly body: Buffer
}

interface Reply {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string | Buffer
}

type Intercept = (exchange: Exchange) => Reply | undefined | Promise<Reply | undefined>

let workspaces: Array<string>
let server: Http.Server
let endpoint: string
let exchanges: Array<Exchange>
let intercept: Intercept
let ac: Map<string, Buffer>
let cas: Map<string, Buffer>

const digestOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** The protocol a conforming cache service speaks, kept in memory. */
const serve = ({ body, method, path }: Exchange): Reply => {
  if (path.startsWith("/ac/")) {
    const key = decodeURIComponent(path.slice("/ac/".length))
    if (method === "PUT") {
      ac.set(key, body)
      return { status: 200 }
    }
    const entry = ac.get(key)
    return entry === undefined ? { status: 404 } : { status: 200, body: entry }
  }
  if (path === "/cas/findMissing") {
    const { digests } = JSON.parse(body.toString("utf8")) as { readonly digests: ReadonlyArray<string> }
    return { status: 200, body: JSON.stringify({ missing: digests.filter((digest) => !cas.has(digest)) }) }
  }
  const digest = path.slice("/cas/".length)
  if (method === "PUT") {
    cas.set(digest, body)
    return { status: 201 }
  }
  const blob = cas.get(digest)
  return blob === undefined ? { status: 404 } : { status: 200, body: blob }
}

beforeEach(async () => {
  workspaces = []
  exchanges = []
  ac = new Map()
  cas = new Map()
  intercept = () => undefined
  server = Http.createServer(async (request, response) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const exchange = { method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks) }
    exchanges.push(exchange)
    const reply = (await intercept(exchange)) ?? serve(exchange)
    if (response.destroyed) return
    response.writeHead(reply.status, reply.headers).end(reply.body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP port")
  endpoint = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  server.close()
  await once(server, "close")
  await Promise.all(workspaces.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async (): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-cas-"))
  workspaces.push(root)
  return root
}

const casPath = (root: string, digest: string): string => NodePath.join(root, ".flows", "cas", digest)

/** Captures one output file into a workspace's local CAS, as the runner does. */
const capture = async (root: string, bytes: Buffer): Promise<string> => {
  const digest = digestOf(bytes)
  await Fs.mkdir(NodePath.dirname(casPath(root, digest)), { recursive: true })
  await Fs.writeFile(casPath(root, digest), bytes)
  return digest
}

const buildResult = (key: string, digests: ReadonlyArray<string>): CachedResult => ({
  key,
  target: "Build",
  label: "//:build",
  exitOk: true,
  output: {
    kind: "build",
    manifests: [],
    files: digests.map((digest, index) => ({ path: `out/${index}.bin`, digest }))
  },
  storedAt: "2026-11-01T00:00:00.000Z"
})

/** Files an entry on the remote directly, as another machine's publication would have. */
const remoteEntry = (result: CachedResult, blobs: ReadonlyArray<Buffer> = []): void => {
  ac.set(result.key, Buffer.from(JSON.stringify(result)))
  for (const blob of blobs) cas.set(digestOf(blob), blob)
}

const open = async (
  root: string,
  options: Omit<Parameters<typeof openCache>[0], "workspaceRoot"> = {}
): Promise<{ readonly cache: CacheStore; readonly warnings: Array<string> }> => {
  const warnings: Array<string> = []
  const cache = await openCache({ workspaceRoot: root, endpoint, warn: (line) => warnings.push(line), ...options })
  return { cache, warnings }
}

const requested = (): Array<string> => exchanges.map(({ method, path }) => `${method} ${path}`)
const count = (method: string, path: string): number =>
  exchanges.filter((exchange) => exchange.method === method && exchange.path === path).length

const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5))
}

const gate = (): { readonly open: () => void; readonly opened: Promise<void> } => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const fetchWith = (
  override: (url: string, init: RequestInit | undefined) => Response | undefined
): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return override(url, init) ?? globalThis.fetch(input, init)
  }) as typeof globalThis.fetch

const busyForever = { status: 429, headers: { "retry-after": "60" } } as const
const degradedGet = (status: number): string =>
  `smthrs: remote cache disabled after a failure: GET returned HTTP ${status}`
const busyWarning = "smthrs: remote cache busy (HTTP 429); skipped one request"
const deniedWarning = "smthrs: remote cache publication refused; this credential may only read"

describe("publication uploads output blobs before the entry", () => {
  it("restores the published blobs into a fresh workspace and then answers locally", async () => {
    const publisher = await workspace()
    const blobs = [Buffer.from("alpha bytes"), Buffer.from("beta bytes")]
    const digests = await Promise.all(blobs.map((blob) => capture(publisher, blob)))
    const entry = buildResult("k1", digests)
    const writer = await open(publisher)
    await writer.cache.put("k1", entry)
    expect(requested()).toEqual([
      "POST /cas/findMissing",
      ...[...digests].sort().map((digest) => `PUT /cas/${digest}`),
      "PUT /ac/k1"
    ])
    expect(writer.warnings).toEqual([])

    const reader = await workspace()
    const { cache, warnings } = await open(reader)
    exchanges = []
    // The remote copy carries the canonical file timestamp; the envelope's
    // publication time is restored, so the reader sees the stored result.
    expect(await cache.get("k1")).toEqual(entry)
    expect(requested().sort()).toEqual(["GET /ac/k1", ...digests.map((digest) => `GET /cas/${digest}`)].sort())
    for (const [index, digest] of digests.entries()) {
      expect(await Fs.readFile(casPath(reader, digest))).toEqual(blobs[index])
    }
    exchanges = []
    expect(await cache.get("k1")).toEqual(entry)
    expect(exchanges).toEqual([])
    expect(warnings).toEqual([])
  })

  it("uploads only the blobs the remote reports missing", async () => {
    const publisher = await workspace()
    const shared = await capture(publisher, Buffer.from("shared"))
    const fresh = await capture(publisher, Buffer.from("fresh"))
    const { cache } = await open(publisher)
    await cache.put("first", buildResult("first", [shared]))
    exchanges = []
    await cache.put("second", buildResult("second", [shared, fresh]))
    expect(requested()).toEqual(["POST /cas/findMissing", `PUT /cas/${fresh}`, "PUT /ac/second"])
  })

  it("probes at most 128 digests per findMissing request", async () => {
    const publisher = await workspace()
    const digests = await Promise.all(
      Array.from({ length: 129 }, (_, index) => capture(publisher, Buffer.from(`file ${index}`)))
    )
    const { cache, warnings } = await open(publisher)
    await cache.put("wide", buildResult("wide", digests))
    const probes = exchanges.filter((exchange) => exchange.path === "/cas/findMissing")
    expect(
      probes.map((probe) => (JSON.parse(probe.body.toString("utf8")) as { digests: Array<string> }).digests.length)
    )
      .toEqual([128, 1])
    expect(count("PUT", "/ac/wide")).toBe(1)
    expect(cas.size).toBe(129)
    expect(warnings).toEqual([])
  })

  it("accepts 200 and 201 for an uploaded blob", async () => {
    const publisher = await workspace()
    const digests = [await capture(publisher, Buffer.from("one")), await capture(publisher, Buffer.from("two"))]
    let puts = 0
    intercept = ({ method, path }) => {
      if (method !== "PUT" || !path.startsWith("/cas/")) return undefined
      puts += 1
      return puts === 1 ? { status: 200 } : undefined
    }
    const { cache, warnings } = await open(publisher)
    await cache.put("mixed", buildResult("mixed", digests))
    expect(count("PUT", "/ac/mixed")).toBe(1)
    expect(warnings).toEqual([])
  })
})

describe("a findMissing probe that cannot be used costs the publication", () => {
  const publishOne = async (options: Omit<Parameters<typeof openCache>[0], "workspaceRoot"> = {}) => {
    const publisher = await workspace()
    const digest = await capture(publisher, Buffer.from("payload"))
    const handle = await open(publisher, options)
    await handle.cache.put("entry", buildResult("entry", [digest]))
    return { ...handle, digest }
  }

  it("skips a publication answered 429 and keeps the remote enabled", async () => {
    let busy = true
    intercept = ({ path }) => path === "/cas/findMissing" && busy ? busyForever : undefined
    const { cache, digest, warnings } = await publishOne()
    expect(count("POST", "/cas/findMissing")).toBe(1)
    expect(ac.has("entry")).toBe(false)
    expect(warnings).toEqual([busyWarning])
    busy = false
    await cache.put("again", buildResult("again", [digest]))
    expect(ac.has("again")).toBe(true)
  })

  it.each([401, 403])("stops publishing but keeps reading when the probe is refused with %i", async (status) => {
    intercept = ({ path }) => path === "/cas/findMissing" ? { status } : undefined
    remoteEntry({ ...buildResult("readable", []), output: { ok: true } })
    const { cache, warnings } = await publishOne()
    expect(ac.has("entry")).toBe(false)
    expect(warnings).toEqual([deniedWarning])
    expect(await cache.get("readable")).toMatchObject({ key: "readable", output: { ok: true } })
  })

  it("names the publication when a probe fails with a server error", async () => {
    intercept = ({ path }) => path === "/cas/findMissing" ? { status: 500 } : undefined
    const { cache, warnings } = await publishOne()
    expect(warnings).toEqual(["smthrs: remote cache disabled after a failure: PUT returned HTTP 500"])
    exchanges = []
    expect(await cache.get("anything")).toBeNull()
    expect(exchanges).toEqual([])
  })

  it.each([
    ["null", "invalid remote CAS missing-digest list"],
    [JSON.stringify({ missing: "all" }), "invalid remote CAS missing-digest list"],
    [JSON.stringify({ missing: ["a".repeat(64), "b".repeat(64)] }), "invalid remote CAS missing-digest list"],
    [JSON.stringify({ missing: [7] }), "invalid remote CAS missing-digest list"],
    [JSON.stringify({ missing: ["c".repeat(64)] }), "invalid remote CAS missing-digest list"],
    [JSON.stringify({ missing: "x".repeat(128 * 1024) }), "invalid remote CAS missing-digest body"],
    ["{", "Expected property name"]
  ])("disables the remote on the unusable probe answer %#", async (body, expected) => {
    intercept = ({ path }) => path === "/cas/findMissing" ? { status: 200, body } : undefined
    const { warnings } = await publishOne()
    expect(ac.has("entry")).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("smthrs: remote cache disabled after a failure: PUT request failed: ")
    expect(warnings[0]).toContain(expected)
  })

  it("refuses a probe answer that lists one digest twice", async () => {
    const publisher = await workspace()
    const digest = await capture(publisher, Buffer.from("payload"))
    intercept = ({ path }) =>
      path === "/cas/findMissing" ? { status: 200, body: JSON.stringify({ missing: [digest, digest] }) } : undefined
    const { cache, warnings } = await open(publisher)
    await cache.put("entry", buildResult("entry", [digest]))
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: PUT request failed: invalid remote CAS missing-digest list"
    ])
    expect(cas.size).toBe(0)
  })

  it("skips slow probes, forgets them after an answer, and disables the remote after a run of them", async () => {
    const publisher = await workspace()
    const digest = await capture(publisher, Buffer.from("payload"))
    let slow = true
    intercept = ({ path }) => path === "/cas/findMissing" && slow ? new Promise<undefined>(() => undefined) : undefined
    const { cache, warnings } = await open(publisher, { timeouts: { get: 150, put: 150 } })
    const publish = async (key: string): Promise<void> => cache.put(key, buildResult(key, [digest]))

    await publish("p1")
    // The slow schedule tries three times before giving up the publication.
    expect(count("POST", "/cas/findMissing")).toBe(3)
    const skipped = "smthrs: remote cache findMissing timed out; skipped one publication"
    expect(warnings).toEqual([skipped])
    slow = false
    await publish("p2")
    expect(ac.has("p2")).toBe(true)
    slow = true
    for (let index = 1; index < findMissingTimeoutLimit; index += 1) await publish(`slow${index}`)
    expect(warnings).toEqual([skipped])
    await publish("last")
    expect(warnings).toEqual([
      skipped,
      `smthrs: remote cache disabled after a failure: PUT request failed: remote cache findMissing timed out ${findMissingTimeoutLimit} publications in a row`
    ])
    expect([...ac.keys()]).toEqual(["p2"])
  }, 30_000)
})

describe("a refused blob upload costs what its status says", () => {
  const uploadAnswered = async (status: number, headers?: Record<string, string>) => {
    const publisher = await workspace()
    const digest = await capture(publisher, Buffer.from("payload"))
    intercept = ({ method, path }) =>
      method === "PUT" && path.startsWith("/cas/")
        ? { status, ...(headers === undefined ? {} : { headers }) }
        : undefined
    const handle = await open(publisher)
    await handle.cache.put("entry", buildResult("entry", [digest]))
    expect(ac.has("entry")).toBe(false)
    return handle
  }

  it.each([401, 403])("stops publishing on %i", async (status) => {
    const { warnings } = await uploadAnswered(status)
    expect(warnings).toEqual([deniedWarning])
  })

  it("skips the publication on 429", async () => {
    const { warnings } = await uploadAnswered(429, { "retry-after": "60" })
    expect(warnings).toEqual([busyWarning])
  })

  it("disables the remote on a server error", async () => {
    const { warnings } = await uploadAnswered(502)
    expect(warnings).toEqual(["smthrs: remote cache disabled after a failure: PUT returned HTTP 502"])
  })

  it("names the network code of an upload that fails in flight", async () => {
    const publisher = await workspace()
    const digest = await capture(publisher, Buffer.from("payload"))
    const { cache, warnings } = await open(publisher, {
      fetch: fetchWith((url, init) => {
        if (init?.method === "PUT" && url.includes("/cas/")) {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
        }
        return undefined
      })
    })
    await cache.put("entry", buildResult("entry", [digest]))
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: PUT request failed: fetch failed (ECONNRESET)"
    ])
  })
})

describe("restores read verified blobs into the local content store", () => {
  it("treats a missing blob as a miss and keeps the remote enabled", async () => {
    remoteEntry(buildResult("gone", ["d".repeat(64)]))
    const blob = Buffer.from("present")
    remoteEntry(buildResult("present", [digestOf(blob)]), [blob])
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("gone")).toBeNull()
    expect(await cache.get("present")).toMatchObject({ key: "present" })
    expect(warnings).toEqual([])
  })

  it("retries a busy blob until it is admitted", async () => {
    const blob = Buffer.from("busy blob")
    remoteEntry(buildResult("busy", [digestOf(blob)]), [blob])
    // A Retry-After that is not a positive number of seconds is ignored.
    const answers: Array<Reply> = [
      { status: 429, headers: { "retry-after": "soon" } },
      { status: 429, headers: { "retry-after": "0" } }
    ]
    intercept = ({ method, path }) => method === "GET" && path.startsWith("/cas/") ? answers.shift() : undefined
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("busy")).toMatchObject({ key: "busy" })
    expect(count("GET", `/cas/${digestOf(blob)}`)).toBe(3)
    expect(warnings).toEqual([])
  })

  it("gives up at once when Retry-After outlasts the retry budget", async () => {
    const blob = Buffer.from("busy blob")
    remoteEntry(buildResult("busy", [digestOf(blob)]), [blob])
    remoteEntry({ ...buildResult("plain", []), output: null })
    intercept = ({ method, path }) => method === "GET" && path.startsWith("/cas/") ? busyForever : undefined
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("busy")).toBeNull()
    expect(count("GET", `/cas/${digestOf(blob)}`)).toBe(1)
    expect(warnings).toEqual([busyWarning])
    expect(await cache.get("plain")).toMatchObject({ key: "plain" })
  })

  it("disables the remote on a blob server error", async () => {
    const blob = Buffer.from("blob")
    remoteEntry(buildResult("broken", [digestOf(blob)]), [blob])
    remoteEntry({ ...buildResult("later", []), output: null })
    intercept = ({ method, path }) => method === "GET" && path.startsWith("/cas/") ? { status: 503 } : undefined
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("broken")).toBeNull()
    expect(warnings).toEqual([degradedGet(503)])
    exchanges = []
    expect(await cache.get("later")).toBeNull()
    expect(exchanges).toEqual([])
  })

  it("disables the remote on a blob body that declares more than one artifact", async () => {
    const blob = Buffer.from("blob")
    remoteEntry(buildResult("huge", [digestOf(blob)]), [blob])
    const { cache, warnings } = await open(await workspace(), {
      fetch: fetchWith((url) =>
        url.includes("/cas/")
          ? new Response("x", { status: 200, headers: { "content-length": String(chunkBytes + 1) } })
          : undefined
      )
    })
    expect(await cache.get("huge")).toBeNull()
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: GET request failed: remote CAS body exceeds its bound or is truncated"
    ])
  })

  it("skips entries that reference more artifacts than a restore admits, warning once", async () => {
    const many = (seed: string): Array<string> =>
      Array.from({ length: 1001 }, (_, index) => digestOf(Buffer.from(`${seed} ${index}`)))
    remoteEntry(buildResult("wide1", many("one")))
    remoteEntry(buildResult("wide2", many("two")))
    remoteEntry({ ...buildResult("small", []), output: 1 })
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("wide1")).toBeNull()
    expect(await cache.get("wide2")).toBeNull()
    expect(exchanges.filter((exchange) => exchange.path.startsWith("/cas/"))).toEqual([])
    expect(warnings).toEqual(["smthrs: remote cache entry exceeds limits; skipped one entry"])
    expect(await cache.get("small")).toMatchObject({ output: 1 })
  })

  it("fetches a blob shared by two concurrent restores once", async () => {
    const blob = Buffer.from("shared blob")
    const digest = digestOf(blob)
    remoteEntry(buildResult("left", [digest]), [blob])
    remoteEntry(buildResult("right", [digest]), [blob])
    intercept = async ({ path }) => {
      if (path !== `/cas/${digest}`) return undefined
      await until(() => count("GET", "/ac/left") + count("GET", "/ac/right") === 2)
      await new Promise((resolve) => setTimeout(resolve, 250))
      return undefined
    }
    const { cache } = await open(await workspace())
    const [left, right] = await Promise.all([cache.get("left"), cache.get("right")])
    expect(left).toMatchObject({ key: "left" })
    expect(right).toMatchObject({ key: "right" })
    expect(count("GET", `/cas/${digest}`)).toBe(1)
  })

  it("replaces a legacy local manifest with the remote chunked one", async () => {
    const publisher = await workspace()
    const large = Buffer.alloc(chunkBytes + 1024, 7)
    large.write("a file larger than one artifact")
    const digest = await capture(publisher, large)
    const legacy = buildResult("big", [digest])
    await (await open(publisher)).cache.put("big", legacy)
    // Publication sends the chunks and their index, never the whole file.
    expect(cas.has(digest)).toBe(false)
    expect(cas.size).toBe(3)

    const reader = await workspace()
    await (await openCache({ workspaceRoot: reader })).put("big", legacy)
    const { cache, warnings } = await open(reader)
    exchanges = []
    const restored = await cache.get("big")
    expect(requested()[0]).toBe(`GET /cas/${digest}`)
    const files = (restored?.output as { readonly files: ReadonlyArray<{ digest: string; index?: string }> }).files
    expect(files[0]?.digest).toBe(digest)
    expect(files[0]?.index).toMatch(/^[a-f0-9]{64}$/)
    expect(digestOf(await Fs.readFile(casPath(reader, digest)))).toBe(digest)
    expect(warnings).toEqual([])
    exchanges = []
    expect(await cache.get("big")).toEqual(restored)
    expect(exchanges).toEqual([])
  }, 30_000)
})

describe("a local hit whose blobs cannot be restored", () => {
  const localHit = async (key: string): Promise<{ readonly root: string; readonly entry: CachedResult }> => {
    const root = await workspace()
    const entry = buildResult(key, [digestOf(Buffer.from(`${key} bytes`))])
    await (await openCache({ workspaceRoot: root })).put(key, entry)
    return { root, entry }
  }

  it("returns the local result when the remote has no entry", async () => {
    const { entry, root } = await localHit("local")
    const { cache, warnings } = await open(root)
    expect(await cache.get("local")).toEqual(entry)
    expect(requested().sort()).toEqual(["GET /ac/local", `GET /cas/${digestOf(Buffer.from("local bytes"))}`])
    expect(warnings).toEqual([])
  })

  it("returns the local result when the remote entry's blobs are gone too", async () => {
    const { entry, root } = await localHit("local")
    remoteEntry(entry)
    const { cache } = await open(root)
    expect(await cache.get("local")).toEqual(entry)
    expect(count("GET", `/cas/${digestOf(Buffer.from("local bytes"))}`)).toBe(2)
  })

  it("returns the local result without a request once the remote is disabled", async () => {
    const { entry, root } = await localHit("local")
    intercept = ({ path }) => path === "/ac/broken" ? { status: 500 } : undefined
    const { cache, warnings } = await open(root)
    expect(await cache.get("broken")).toBeNull()
    exchanges = []
    expect(await cache.get("local")).toEqual(entry)
    expect(exchanges).toEqual([])
    expect(warnings).toEqual([degradedGet(500)])
  })

  it("returns the local result and publishes nothing when the content store leaves the workspace", async () => {
    const { entry, root } = await localHit("local")
    const outside = await workspace()
    await Fs.symlink(outside, NodePath.join(root, ".flows", "cas"))
    const { cache, warnings } = await open(root)
    expect(await cache.get("local")).toEqual(entry)
    const other = { ...entry, key: "other" }
    await cache.put("other", other)
    expect(exchanges).toEqual([])
    expect(await (await openCache({ workspaceRoot: root })).get("other")).toEqual(other)
    expect(warnings).toEqual([])
  })
})

it("answers a remote hit even when it cannot be kept locally", async () => {
  remoteEntry({ ...buildResult("hit", []), output: { ok: true } })
  const root = await workspace()
  const { cache } = await open(root, {
    io: { rename: () => Promise.reject(Object.assign(new Error("read-only file system"), { code: "EROFS" })) }
  })
  expect(await cache.get("hit")).toMatchObject({ key: "hit", output: { ok: true } })
  await expect(Fs.readdir(NodePath.join(root, ".flows", "cache", "hi"))).resolves.toEqual([])
  exchanges = []
  expect(await cache.get("hit")).toMatchObject({ key: "hit" })
  expect(requested()).toEqual(["GET /ac/hit"])
})

describe("remote metadata answers", () => {
  const epoch = "1970-01-01T00:00:00.000Z"
  const envelope = (createdAtMs: unknown): Buffer =>
    Buffer.from(JSON.stringify({
      keyDigest: "stamped",
      result: { ...buildResult("stamped", []), output: null, storedAt: epoch },
      createdAtMs
    }))

  it("restores the publication time of a file result from the envelope", async () => {
    ac.set("stamped", envelope(Date.parse("2026-10-01T12:00:00.000Z")))
    const { cache } = await open(await workspace())
    expect((await cache.get("stamped"))?.storedAt).toBe("2026-10-01T12:00:00.000Z")
  })

  it.each([["a string", "1700000000000"], ["a fraction", 1.5], ["out of Date range", 8_640_000_000_000_001]])(
    "keeps the canonical timestamp when createdAtMs is %s",
    async (_name, createdAtMs) => {
      ac.set("stamped", envelope(createdAtMs))
      const { cache } = await open(await workspace())
      expect((await cache.get("stamped"))?.storedAt).toBe(epoch)
    }
  )

  it("disables the remote on a body that is not JSON", async () => {
    intercept = ({ path }) => path === "/ac/k" ? { status: 200, body: "{" } : undefined
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("k")).toBeNull()
    expect(warnings).toEqual(["smthrs: remote cache disabled after a failure: GET request failed"])
  })

  it("warns once about repeated conflicts", async () => {
    intercept = ({ method, path }) => method === "PUT" && path.startsWith("/ac/") ? { status: 409 } : undefined
    const { cache, warnings } = await open(await workspace())
    await cache.put("one", { ...buildResult("one", []), output: 1 })
    await cache.put("two", { ...buildResult("two", []), output: 2 })
    expect(count("PUT", "/ac/two")).toBe(1)
    expect(warnings).toEqual(["smthrs: remote cache conflict; keeping the first published result"])
  })
})

describe("remote bodies are read with a hard bound", () => {
  const answered = async (response: () => Response): Promise<Array<string>> => {
    const { cache, warnings } = await open(await workspace(), { fetch: fetchWith(() => response()) })
    expect(await cache.get("k")).toBeNull()
    return warnings
  }
  const refused = ["smthrs: remote cache disabled after a failure: GET request failed"]
  const refusingCancel = (chunks: Array<unknown>): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      // The stream stays open after its chunks, so a cancel reaches the source.
      pull(controller) {
        const next = chunks.shift()
        if (next !== undefined) controller.enqueue(next as Uint8Array)
      },
      cancel() {
        throw new Error("cancel refused")
      }
    })

  it.each([
    ["no body and no length", () => new Response(null, { status: 200 })],
    ["no body and a zero length", () => new Response(null, { status: 200, headers: { "content-length": "0" } })],
    ["no body for a declared length", () => new Response(null, { status: 200, headers: { "content-length": "5" } })],
    ["a chunk that is not bytes", () => new Response(refusingCancel(["text"]), { status: 200 })],
    [
      "a body over the entry limit",
      () => new Response(refusingCancel([new Uint8Array(remoteEntryLimit + 1)]), { status: 200 })
    ]
  ])("refuses %s even when cancellation fails", async (_name, response) => {
    expect(await answered(response)).toEqual(refused)
  })

  it("refuses a body whose reader cannot be released", async () => {
    const unreleasable = {
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
          releaseLock: () => {
            throw new TypeError("reader is still in use")
          }
        })
      }
    } as unknown as Response
    expect(await answered(() => unreleasable)).toEqual(refused)
  })

  it("keeps a miss a miss when its body cannot be cancelled", async () => {
    const locked = (): Response => {
      const response = new Response("not here", { status: 404 })
      response.body?.getReader()
      return response
    }
    expect(await answered(locked)).toEqual([])
  })
})

describe("failure descriptions stay bounded and credential-free", () => {
  it("describes a non-Error rejection and redacts the token", async () => {
    const { cache, warnings } = await open(await workspace(), {
      readToken: () => "token-abcd",
      fetch: () => Promise.reject("refused for token-abcd")
    })
    expect(await cache.get("k")).toBeNull()
    expect(warnings).toEqual([
      "smthrs: remote cache disabled after a failure: GET request failed: refused for [redacted]"
    ])
  })

  it("names no code when the network cause carries none", async () => {
    const { cache, warnings } = await open(await workspace(), {
      fetch: () => Promise.reject(new TypeError("fetch failed", { cause: { errno: -104 } }))
    })
    expect(await cache.get("k")).toBeNull()
    expect(warnings).toEqual(["smthrs: remote cache disabled after a failure: GET request failed: fetch failed"])
  })

  it("truncates a long failure message", async () => {
    const { cache, warnings } = await open(await workspace(), {
      fetch: () => Promise.reject(new Error("x".repeat(400)))
    })
    expect(await cache.get("k")).toBeNull()
    expect(warnings).toEqual([
      `smthrs: remote cache disabled after a failure: GET request failed: ${"x".repeat(300)}...`
    ])
  })

  it("describes a token reader that throws without calling it a token", async () => {
    const { cache, warnings } = await open(await workspace(), {
      readToken: () => {
        throw new Error("vault locked")
      }
    })
    expect(await cache.get("k")).toBeNull()
    expect(warnings).toEqual(["smthrs: remote cache disabled after a failure: GET request failed: vault locked"])
    expect(exchanges).toEqual([])
  })
})

describe("concurrent exchanges see the remote another exchange disabled", () => {
  it("does not retry a busy blob once a sibling disabled the remote, and warns about the failure once", async () => {
    const blobs = [Buffer.from("first"), Buffer.from("second"), Buffer.from("third")]
    const [first, second, third] = blobs.map(digestOf) as [string, string, string]
    remoteEntry(buildResult("trio", [first, second, third]), blobs)
    let failed = false
    intercept = async ({ path }) => {
      if (path === `/cas/${first}`) {
        failed = true
        return { status: 500 }
      }
      if (path === `/cas/${second}` || path === `/cas/${third}`) {
        await until(() => failed)
        await new Promise((resolve) => setTimeout(resolve, 100))
        return path === `/cas/${second}` ? { status: 429 } : { status: 500 }
      }
      return undefined
    }
    const { cache, warnings } = await open(await workspace())
    expect(await cache.get("trio")).toBeNull()
    expect(count("GET", `/cas/${second}`)).toBe(1)
    expect(warnings[0]).toBe(degradedGet(500))
    expect(warnings.filter((line) => line.includes("disabled"))).toHaveLength(1)
  })

  it("stops between probe batches once the remote is disabled", async () => {
    const publisher = await workspace()
    const digests = await Promise.all(
      Array.from({ length: 129 }, (_, index) => capture(publisher, Buffer.from(`file ${index}`)))
    )
    const held = gate()
    intercept = async ({ path }) => {
      if (path === "/ac/broken") return { status: 500 }
      if (path !== "/cas/findMissing") return undefined
      await held.opened
      return { status: 200, body: JSON.stringify({ missing: [] }) }
    }
    const { cache, warnings } = await open(publisher)
    const publishing = cache.put("wide", buildResult("wide", digests))
    await until(() => count("POST", "/cas/findMissing") === 1)
    expect(await cache.get("broken")).toBeNull()
    held.open()
    await publishing
    expect(count("POST", "/cas/findMissing")).toBe(1)
    expect(ac.has("wide")).toBe(false)
    expect(warnings).toEqual([degradedGet(500)])
  })

  it("stops between blob uploads once the remote is disabled", async () => {
    const publisher = await workspace()
    const digests = [await capture(publisher, Buffer.from("one")), await capture(publisher, Buffer.from("two"))]
    const held = gate()
    intercept = async ({ method, path }) => {
      if (path === "/ac/broken") return { status: 500 }
      if (method !== "PUT" || !path.startsWith("/cas/")) return undefined
      await held.opened
      return undefined
    }
    const { cache, warnings } = await open(publisher)
    const publishing = cache.put("pair", buildResult("pair", digests))
    await until(() => exchanges.some((exchange) => exchange.method === "PUT"))
    expect(await cache.get("broken")).toBeNull()
    held.open()
    await publishing
    expect(exchanges.filter((exchange) => exchange.method === "PUT")).toHaveLength(1)
    expect(ac.has("pair")).toBe(false)
    expect(warnings).toEqual([degradedGet(500)])
  })

  it.each(
    [
      ["disabled", { status: 500 }, ["smthrs: remote cache disabled after a failure: PUT returned HTTP 500"]],
      ["refused publication", { status: 403 }, [deniedWarning]]
    ] as const
  )("drops a probed publication when the remote was %s meanwhile", async (_name, reply, expected) => {
    const publisher = await workspace()
    const left = await capture(publisher, Buffer.from("left"))
    const right = await capture(publisher, Buffer.from("right"))
    const held = gate()
    intercept = async ({ body, path }) => {
      if (path !== "/cas/findMissing") return undefined
      if (body.includes(right)) return reply
      await held.opened
      return { status: 200, body: JSON.stringify({ missing: [] }) }
    }
    const { cache, warnings } = await open(publisher)
    const publishing = cache.put("left", buildResult("left", [left]))
    await until(() => count("POST", "/cas/findMissing") === 1)
    await cache.put("right", buildResult("right", [right]))
    held.open()
    await publishing
    expect(ac.size).toBe(0)
    expect(warnings).toEqual(expected)
  })

  it("warns once when two concurrent publications are refused", async () => {
    const publisher = await workspace()
    const left = await capture(publisher, Buffer.from("left"))
    const right = await capture(publisher, Buffer.from("right"))
    intercept = async ({ path }) => {
      if (path !== "/cas/findMissing") return undefined
      await until(() => count("POST", "/cas/findMissing") === 2)
      return { status: 401 }
    }
    const { cache, warnings } = await open(publisher)
    await Promise.all([
      cache.put("left", buildResult("left", [left])),
      cache.put("right", buildResult("right", [right]))
    ])
    expect(warnings).toEqual([deniedWarning])
  })

  it("does not prepare a publication queued behind restores that disabled the remote", async () => {
    const blobs = Array.from({ length: 9 }, (_, index) => Buffer.from(`restore ${index}`))
    remoteEntry(buildResult("restore", blobs.map(digestOf)), blobs)
    const held = gate()
    intercept = async ({ method, path }) => {
      if (method !== "GET" || !path.startsWith("/cas/")) return undefined
      await held.opened
      return { status: 500 }
    }
    const root = await workspace()
    const { cache, warnings } = await open(root)
    const restoring = cache.get("restore")
    await until(() => exchanges.filter((exchange) => exchange.path.startsWith("/cas/")).length === 2)
    const publisher = await capture(root, Buffer.from("queued output"))
    const publishing = cache.put("queued", buildResult("queued", [publisher]))
    await until(() => existsSync(NodePath.join(root, ".flows", "cache", "qu", "queued.json")))
    await new Promise((resolve) => setTimeout(resolve, 200))
    held.open()
    expect(await restoring).toBeNull()
    await publishing
    expect(count("POST", "/cas/findMissing")).toBe(0)
    expect(ac.has("queued")).toBe(false)
    expect(warnings).toEqual([degradedGet(500)])
  })
})
