import { Effect, Redacted } from "effect"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { describe, expect, test } from "vitest"
import { GitProxy } from "../src/index.ts"
import { brokenBody, httpClient, telemetry } from "./fixtures.ts"

// The read-only git proxy a sandbox clones through, against a scripted git host on the `fetch` seam. The guest's
// requests arrive as a Worker would hand them to the host: web Requests, here from `forge.smithers.internal`.

const UPSTREAM = { url: "https://acme.code.storage/github/o/n.git", authorization: Redacted.make("Basic dDpzZWNyZXQ=") }
const GUEST = "http://forge.smithers.internal/o/n"

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string
}

const proxy = async (
  request: Request,
  answer: (request: Request) => Response | "throw" = () =>
    new Response("advertisement", {
      status: 200,
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
        "cache-control": "no-cache",
        "set-cookie": "upstream=1",
        "x-github-request-id": "abc"
      }
    }),
  upstream: typeof UPSTREAM | { readonly url: string } = UPSTREAM,
  branch?: string
) => {
  const seen: Array<Seen> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const outgoing = input instanceof Request ? input : new Request(input, init)
    seen.push({
      method: outgoing.method,
      url: outgoing.url,
      headers: outgoing.headers,
      body: outgoing.method === "POST" ? await outgoing.text() : ""
    })
    const response = answer(outgoing)
    if (response === "throw") throw new TypeError("fetch failed")
    return response
  }
  const recorded = telemetry()
  // The body streams with the request's services, as a server streams it, so its records land with the test's.
  const { response, context } = await Effect.runPromise(
    recorded.provide(
      Effect.all({
        response: GitProxy.uploadPack(HttpServerRequest.fromWeb(request), upstream, branch),
        context: Effect.context<never>()
      }).pipe(Effect.provide(httpClient(fetch)))
    )
  )
  const web = HttpServerResponse.toWeb(response, { context })
  return { response: web, body: await web.text(), seen, recorded }
}

describe("GitProxy.classify", () => {
  test.each(
    [
      ["GET", "/o/n/info/refs?service=git-upload-pack", "info-refs"],
      ["GET", "/anything/else.git/info/refs?service=git-upload-pack", "info-refs"],
      ["POST", "/o/n/git-upload-pack", "upload-pack"],
      ["GET", "/o/n/info/refs?service=git-receive-pack", undefined],
      ["GET", "/o/n/info/refs?service=git-upload-pack&service=git-receive-pack", undefined],
      ["GET", "/o/n/info/refs", undefined],
      ["POST", "/o/n/git-receive-pack", undefined],
      ["POST", "/o/n/git-upload-pack?x=1", undefined],
      ["GET", "/o/n/git-upload-pack", undefined],
      ["PUT", "/o/n/info/refs?service=git-upload-pack", undefined],
      ["GET", "/o/n/info/lfs/objects/batch", undefined],
      ["GET", "/o/n/HEAD", undefined],
      ["GET", "//", undefined],
      ["GET", "//x/info/refs?service=git-upload-pack", "info-refs"]
    ] as const
  )("%s %s is %s", (method, path, service) => {
    expect(GitProxy.classify(method, path)).toBe(service)
    expect(GitProxy.classify(method, `${GUEST}${path}`)).toBe(service)
  })
})

describe("GitProxy.uploadPack", () => {
  test("refuses a malformed guest URL with a counted, logged 403", async () => {
    const { response, seen, recorded } = await proxy(new Request("http://forge.smithers.internal//"))
    expect(response.status).toBe(403)
    expect(seen).toEqual([])
    expect(recorded.count(GitProxy.requests, { service: "refused", outcome: "refused" })).toBe(1)
    expect(recorded.logs).toContainEqual({
      message: ["git.proxy"],
      annotations: expect.objectContaining({ service: "refused", outcome: "refused", status: 403 })
    })
    const span = recorded.spans.find((span) => span.name === "GitProxy.uploadPack")!
    expect(span.attributes.get("git.proxy.service")).toBe("refused")
    expect(span.attributes.get("http.response.status_code")).toBe(403)
  })

  test.each(
    [
      ["GET", "info/refs?service=git-upload-pack", "info-refs", 200],
      ["POST", "git-upload-pack", "upload-pack", 200],
      ["GET", "info/refs?service=git-upload-pack", "info-refs", 404]
    ] as const
  )("annotates %s %s with %s and status %i before returning its body", async (method, path, service, status) => {
    const recorded = telemetry()
    const fetch: typeof globalThis.fetch = async () => new Response("body", { status })
    const { response, context } = await Effect.runPromise(recorded.provide(
      Effect.all({
        response: GitProxy.uploadPack(HttpServerRequest.fromWeb(new Request(GUEST + "/" + path, { method })), UPSTREAM),
        context: Effect.context<never>()
      }).pipe(Effect.provide(httpClient(fetch)))
    ))
    const span = recorded.spans.find((span) => span.name === "GitProxy.uploadPack")!
    expect(span.status._tag).toBe("Ended")
    expect(Object.fromEntries(span.attributes)).toEqual({
      "git.proxy.service": service,
      "http.response.status_code": status
    })
    expect(recorded.count(GitProxy.requests, { service, outcome: status === 200 ? "ok" : "4xx" })).toBe(0)
    expect(await HttpServerResponse.toWeb(response, { context }).text()).toBe("body")
    expect(recorded.count(GitProxy.requests, { service, outcome: status === 200 ? "ok" : "4xx" })).toBe(1)
  })

  test("sends the ref advertisement request to the upstream with its credential, never the guest's", async () => {
    const { response, body, seen, recorded } = await proxy(
      new Request(`${GUEST}/info/refs?service=git-upload-pack`, {
        headers: { authorization: "Basic Z3Vlc3Q6Z3Vlc3Q=", "git-protocol": "version=2", cookie: "a=b", accept: "*/*" }
      })
    )
    expect(response.status).toBe(200)
    expect(body).toBe("advertisement")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe("https://acme.code.storage/github/o/n.git/info/refs?service=git-upload-pack")
    expect(seen[0]!.headers.get("authorization")).toBe("Basic dDpzZWNyZXQ=")
    expect(seen[0]!.headers.get("git-protocol")).toBe("version=2")
    expect(seen[0]!.headers.get("accept")).toBe("*/*")
    expect(seen[0]!.headers.get("cookie")).toBeNull()
    expect(seen[0]!.headers.get("accept-encoding")).toBe("identity")
    // Only git's own headers come back.
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-github-request-id")).toBeNull()
    expect(recorded.count(GitProxy.requests, { service: "info-refs", outcome: "ok" })).toBe(1)
    expect(recorded.recorded()).not.toContain("dDpzZWNyZXQ")
    expect(recorded.recorded()).not.toContain("Z3Vlc3Q")
  })

  test("streams the negotiation body to the upstream and the pack back", async () => {
    const { response, body, seen, recorded } = await proxy(
      new Request(`${GUEST}/git-upload-pack`, {
        method: "POST",
        body: "0032want d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9\n00000009done\n",
        headers: { "content-type": "application/x-git-upload-pack-request", "content-encoding": "identity" }
      }),
      () =>
        new Response(new Blob(["PA", "CK"]).stream(), {
          status: 200,
          headers: { "content-type": "application/x-git-upload-pack-result" }
        })
    )
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url).toBe("https://acme.code.storage/github/o/n.git/git-upload-pack")
    expect(seen[0]!.body).toBe("0032want d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9\n00000009done\n")
    expect(seen[0]!.headers.get("content-type")).toBe("application/x-git-upload-pack-request")
    expect(seen[0]!.headers.get("content-encoding")).toBe("identity")
    expect(response.status).toBe(200)
    expect(body).toBe("PACK")
    expect(recorded.count(GitProxy.requests, { service: "upload-pack", outcome: "ok" })).toBe(1)
  })

  test("a pack that breaks off breaks the guest's response too, and counts as broken, never ok", async () => {
    const recorded = telemetry()
    const fetch: typeof globalThis.fetch = async () => new Response(brokenBody("PACK"), { status: 200 })
    const { response, context } = await Effect.runPromise(
      recorded.provide(
        Effect.all({
          response: GitProxy.uploadPack(
            HttpServerRequest.fromWeb(new Request(`${GUEST}/git-upload-pack`, { method: "POST", body: "0000" })),
            UPSTREAM
          ),
          context: Effect.context<never>()
        }).pipe(Effect.provide(httpClient(fetch)))
      )
    )
    await expect(HttpServerResponse.toWeb(response, { context }).text()).rejects.toThrow()
    expect(recorded.count(GitProxy.requests, { service: "upload-pack", outcome: "broken" })).toBe(1)
    expect(recorded.count(GitProxy.requests, { service: "upload-pack", outcome: "ok" })).toBe(0)
  })

  test("a gzipping upstream behind a real fetch: the guest gets the decoded bytes and no Content-Encoding", async () => {
    // GitHub gzips info/refs whatever the client asks; a real `fetch` decodes it, so passing its encoding on would make
    // git gunzip plain bytes. A local server stands in for the upstream, so the network stack is the real one.
    const advertisement = "001e# service=git-upload-pack\n0000"
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
        "content-encoding": "gzip"
      })
      response.end(gzipSync(advertisement))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      const response = await Effect.runPromise(
        GitProxy.uploadPack(
          HttpServerRequest.fromWeb(new Request(`${GUEST}/info/refs?service=git-upload-pack`)),
          { url: `http://127.0.0.1:${port}/o/n.git` }
        ).pipe(Effect.provide(FetchHttpClient.layer))
      )
      const web = HttpServerResponse.toWeb(response)
      expect(web.headers.get("content-encoding")).toBeNull()
      expect(await web.text()).toBe(advertisement)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test("sends no credential when the upstream has none", async () => {
    const { seen } = await proxy(
      new Request(`${GUEST}/info/refs?service=git-upload-pack`),
      undefined,
      { url: "https://github.com/o/n.git/" }
    )
    expect(seen[0]!.url).toBe("https://github.com/o/n.git/info/refs?service=git-upload-pack")
    expect(seen[0]!.headers.get("authorization")).toBeNull()
  })

  test("refuses a push before anything reaches the upstream", async () => {
    const { response, seen, recorded } = await proxy(
      new Request(`${GUEST}/git-receive-pack`, { method: "POST", body: "0000" })
    )
    expect(response.status).toBe(403)
    expect(seen).toEqual([])
    expect(recorded.count(GitProxy.requests, { service: "refused", outcome: "refused" })).toBe(1)
  })

  test("passes an upstream's refusal back by its status", async () => {
    const { response, recorded } = await proxy(
      new Request(`${GUEST}/info/refs?service=git-upload-pack`),
      () => new Response("no", { status: 404, headers: { "content-type": "text/plain" } })
    )
    expect(response.status).toBe(404)
    expect(recorded.count(GitProxy.requests, { service: "info-refs", outcome: "4xx" })).toBe(1)
  })

  test("answers 502 when the upstream doesn't answer", async () => {
    const { response, recorded } = await proxy(new Request(`${GUEST}/info/refs?service=git-upload-pack`), () => "throw")
    expect(response.status).toBe(502)
    expect(recorded.count(GitProxy.requests, { service: "info-refs", outcome: "transport" })).toBe(1)
    expect(recorded.spans.map((span) => span.name)).toContain("GitProxy.uploadPack")
  })
})

const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line
const tip = "a".repeat(40)
const other = "b".repeat(40)
const listing = () =>
  new Response(pkt(`${tip} refs/heads/conversation\n`) + pkt(`${other} refs/heads/private\n`) + "0000", {
    headers: { "content-type": "application/x-git-upload-pack-result" }
  })

describe("branch scoped proxy", () => {
  test("negotiates v0 and advertises only the selected branch, with no upstream capabilities", async () => {
    const result = await proxy(
      new Request(`${GUEST}/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" }
      }),
      listing,
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(200)
    expect(result.body).toContain(`${tip} refs/heads/conversation`)
    expect(result.body).not.toContain("private")
    expect(result.body).not.toContain("version 2")
  })

  test("allows the exact tip, strips have probes, and forwards only validated v0 negotiation", async () => {
    const input = pkt(`want ${tip} side-band-64k ofs-delta\n`) + "0000" + pkt(`have ${other}\n`) + pkt("done\n")
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body: input }),
      (request) => request.headers.get("git-protocol") === "version=2" ? listing() : new Response("PACK"),
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(200)
    expect(result.body).toBe("PACK")
    expect(result.seen.at(-1)!.body).toBe(pkt(`want ${tip} side-band-64k ofs-delta\n`) + "0000" + pkt("done\n"))
  })

  test.each(["gzip", "x-gzip"])("decodes %s before validating and stripping have probes", async (encoding) => {
    const wanted = pkt(`want ${tip} side-band-64k ofs-delta\n`) + "0000"
    const input = wanted + pkt(`have ${other}\n`).repeat(32) + pkt("done\n")
    expect(new TextEncoder().encode(input).length).toBeGreaterThan(1024)
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, {
        method: "POST",
        body: gzipSync(input),
        headers: { "content-encoding": encoding }
      }),
      (request) => request.headers.get("git-protocol") === "version=2" ? listing() : new Response("PACK"),
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(200)
    expect(result.body).toBe("PACK")
    expect(result.seen.at(-1)!.body).toBe(wanted + pkt("done\n"))
    expect(result.seen.at(-1)!.headers.get("content-encoding")).toBeNull()
    expect(result.seen.at(-1)!.headers.get("git-protocol")).toBeNull()
    expect(result.seen.at(-1)!.headers.get("content-type")).toBe("application/x-git-upload-pack-request")
    expect(result.recorded.count(GitProxy.requests, { service: "upload-pack", outcome: "ok" })).toBe(1)
  })

  test.each([
    new Uint8Array([1, 2, 3]),
    gzipSync(pkt(`want ${tip}\n`) + "0000" + pkt("done\n")).subarray(0, -1),
    gzipSync(pkt(`want ${other}\n`) + "0000" + pkt("done\n"))
  ])("refuses malformed gzip or compressed private wants without forwarding a pack request", async (body) => {
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body, headers: { "content-encoding": "gzip" } }),
      listing,
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(403)
    expect(result.seen).toHaveLength(1)
    expect(result.seen[0]!.headers.get("git-protocol")).toBe("version=2")
    expect(result.recorded.count(GitProxy.requests, { service: "upload-pack", outcome: "refused" })).toBe(1)
  })

  test.each([20_971, 20_972])("caps decoded gzip bytes rather than compressed bytes: %i wants", async (wants) => {
    const input = pkt(`want ${tip}\n`).repeat(wants) + "0000" + pkt("done\n")
    const body = gzipSync(input)
    expect(body.length).toBeLessThan(1024 * 1024)
    const allowed = new TextEncoder().encode(input).length <= 1024 * 1024
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body, headers: { "content-encoding": "gzip" } }),
      (request) => request.headers.get("git-protocol") === "version=2" ? listing() : new Response("PACK"),
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(allowed ? 200 : 403)
    expect(result.seen).toHaveLength(allowed ? 2 : 1)
    if (allowed) expect(result.seen.at(-1)!.body).toBe(input)
  })

  test.each([
    pkt(`want ${other}\n`) + "0000" + pkt("done\n"),
    pkt(`want ${tip}\n`) + pkt(`want ${other}\n`) + "0000" + pkt("done\n"),
    pkt("command=fetch\n") + "0001" + pkt(`want ${other}\n`) + "0000",
    pkt(`want ${tip}\n`) + pkt("filter blob:none\n") + "0000" + pkt("done\n"),
    pkt("want-ref refs/heads/private\n") + "0000",
    pkt(`want ${tip} allow-tip-sha1-in-want\n`) + "0000" + pkt("done\n"),
    pkt("command=ls-refs\n") + "00010000",
    pkt(`shallow ${other}\n`) + "0000",
    "0000junk",
    "0001",
    "ffffwant",
    "00000000",
    "0000",
    "z000",
    "0005\ufffd"
  ])("refuses unsafe negotiation %s", async (body) => {
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body }),
      listing,
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(403)
    expect(result.seen.every((request) => request.headers.get("git-protocol") === "version=2")).toBe(true)
  })

  test.each([
    { "content-encoding": "br" },
    { "content-encoding": "deflate" },
    { "content-encoding": "gzip, gzip" },
    { "git-protocol": "version=3" }
  ])(
    "refuses unsupported encodings or protocols",
    async (headers) => {
      const result = await proxy(
        new Request(`${GUEST}/git-upload-pack`, { method: "POST", body: "0000", headers }),
        listing,
        UPSTREAM,
        "conversation"
      )
      expect(result.response.status).toBe(403)
      expect(result.seen).toEqual([])
    }
  )
})

test("scoped discovery fails closed when its branch cannot be read", async () => {
  const result = await proxy(
    new Request(`${GUEST}/info/refs?service=git-upload-pack`),
    () => "throw",
    UPSTREAM,
    "conversation"
  )
  expect(result.response.status).toBe(502)
  expect(result.recorded.count(GitProxy.requests, { service: "info-refs", outcome: "transport" })).toBe(1)
})

test.each(["", "a\nb", "a..b", "a@{b", "a//b", "-b", "/b", "b/", "b.", ".b", "a/.b", "a.lock", "a".repeat(256)])(
  "invalid scoped branch %s is refused before any provider request",
  async (branch) => {
    const result = await proxy(new Request(`${GUEST}/info/refs?service=git-upload-pack`), listing, UPSTREAM, branch)
    expect(result.response.status).toBe(403)
    expect(result.seen).toEqual([])
  }
)

test("unsupported discovery protocol is refused", async () => {
  const result = await proxy(
    new Request(`${GUEST}/info/refs?service=git-upload-pack`, { headers: { "git-protocol": "version=3" } }),
    listing,
    UPSTREAM,
    "conversation"
  )
  expect(result.response.status).toBe(403)
  expect(result.seen).toEqual([])
})

test.each([new Uint8Array([48, 48, 48, 53, 255]), new Uint8Array(1024 * 1024 + 1)])(
  "invalid UTF-8 or oversized scoped bodies never reach upload-pack",
  async (body) => {
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body }),
      listing,
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(403)
    expect(result.seen).toHaveLength(1)
  }
)

test("a failed guest body is refused without forwarding partial negotiation", async () => {
  const result = await proxy(
    new Request(`${GUEST}/git-upload-pack`, {
      method: "POST",
      body: brokenBody("0000"),
      duplex: "half"
    } as RequestInit),
    listing,
    UPSTREAM,
    "conversation"
  )
  expect(result.response.status).toBe(403)
  expect(result.seen).toHaveLength(1)
})

test.each([
  pkt(`want ${tip}\n`) + pkt(`want ${tip}\n`) + "00000000",
  pkt(`want ${tip}\n`) + "0000" + pkt(`have ${other}\n`) + "0000"
])("accepts safe repeated wants or a negotiation round", async (body) => {
  const result = await proxy(
    new Request(`${GUEST}/git-upload-pack`, { method: "POST", body, headers: { "content-encoding": "identity" } }),
    (request) => request.headers.get("git-protocol") === "version=2" ? listing() : new Response("NAK"),
    UPSTREAM,
    "conversation"
  )
  expect(result.response.status).toBe(200)
  expect(result.body).toBe("NAK")
  expect(result.seen.at(-1)!.body).not.toContain(other)
})

test.each([
  pkt(`want ${tip}\n`) + pkt(`want ${tip} ofs-delta\n`) + "00000000",
  pkt(`want ${tip}\n`),
  pkt(`want ${tip}\n`) + "0000" + pkt("deepen 1\n"),
  pkt(`want ${tip}\n`) + "0000" + pkt("done\n") + pkt("done\n")
])("rejects misplaced capabilities, incomplete rounds, and trailing commands", async (body) => {
  const result = await proxy(
    new Request(`${GUEST}/git-upload-pack`, { method: "POST", body }),
    listing,
    UPSTREAM,
    "conversation"
  )
  expect(result.response.status).toBe(403)
  expect(result.seen).toHaveLength(1)
})

test.each(["version=0", "version=1", "version=2"])(
  "negotiated v0 bodies remain safe with a retained %s header",
  async (protocol) => {
    const body = pkt(`want ${tip} ofs-delta\n`) + "0000" + pkt("done\n")
    const result = await proxy(
      new Request(`${GUEST}/git-upload-pack`, { method: "POST", body, headers: { "git-protocol": protocol } }),
      (request) => request.headers.get("git-protocol") === "version=2" ? listing() : new Response("PACK"),
      UPSTREAM,
      "conversation"
    )
    expect(result.response.status).toBe(200)
    expect(result.body).toBe("PACK")
    expect(result.seen.at(-1)!.headers.get("git-protocol")).toBeNull()
  }
)
