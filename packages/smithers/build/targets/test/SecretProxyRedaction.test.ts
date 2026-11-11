import * as NodeHttp from "node:http"
import { describe, expect, it } from "vitest"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"

const listen = async (
  handler: NodeHttp.RequestListener
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> => {
  const server = NodeHttp.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no upstream port")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

interface Answer {
  readonly status: number
  readonly body: string
  readonly headers: NodeHttp.IncomingHttpHeaders
}

const get = (url: string): Promise<Answer> =>
  new Promise<Answer>((resolve, reject) => {
    NodeHttp.get(url, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }))
    }).on("error", reject)
  })

describe("secret destination redaction", () => {
  it("refuses a destination with URL credentials before contacting upstream", async () => {
    let contacts = 0
    const upstream = await listen((_request, response) => {
      contacts += 1
      response.end("unexpected")
    })
    const destination = upstream.origin.replace("http://", "http://user:password@") + "/private"
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const answer = await get(proxy.urlFor(Secret.Secret("PROXY_CREDENTIALED_DESTINATION")))
      expect(answer).toMatchObject({ status: 400, body: "proxy request URLs must not contain credentials" })
      expect(contacts).toBe(0)
      expect(answer.body).not.toContain("password")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("redacts every Set-Cookie value and removes upstream connection-nominated headers", async () => {
    let destination = ""
    const upstream = await listen((_request, response) => {
      response.writeHead(200, {
        "connection": "x-internal",
        "x-internal": destination,
        "set-cookie": [`first=${destination}; HttpOnly`, `second=${destination}; Secure`]
      })
      response.end("ok")
    })
    destination = `${upstream.origin}/private/path?key=value`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_COOKIE_DESTINATION"))
      const answer = await get(capability)
      expect(answer.status).toBe(200)
      expect(answer.body).toBe("ok")
      expect(answer.headers["x-internal"]).toBeUndefined()
      expect(answer.headers["set-cookie"]).toEqual([
        `first=${capability}; HttpOnly`,
        `second=${capability}; Secure`
      ])
      expect(JSON.stringify(answer.headers)).not.toContain(destination)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("never returns the resolved destination URL to the child, in body or headers", async () => {
    const upstream = await listen((request, response) => {
      const echoed = `${request.headers["host"] ?? ""}${request.url ?? ""}`
      response.writeHead(404, { "x-echo-url": `http://${echoed}` })
      response.end(`called http://${echoed}`)
    })
    const destination = `${upstream.origin}/secret-webhook/abc123?token=zzz`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      expect(answer.status).toBe(404)
      expect(answer.body).not.toContain("secret-webhook/abc123")
      expect(answer.body).not.toContain(destination)
      expect(answer.body).toContain(capability)
      const echo = answer.headers["x-echo-url"]
      expect(typeof echo === "string" ? echo : "").not.toContain("secret-webhook/abc123")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("redacts a destination pathname echoed without its query", async () => {
    const upstream = await listen((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://upstream.invalid").pathname
      response.writeHead(200, { "x-echo-pathname": pathname })
      response.end(`pathname=${pathname}`)
    })
    const secretPathname = "/secret-webhook/abc123"
    const destination = `${upstream.origin}${secretPathname}?token=zzz`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      const echoed = answer.headers["x-echo-pathname"]
      expect(answer.status).toBe(200)
      expect(answer.body).not.toContain(secretPathname)
      expect(answer.body).not.toContain("secret-webhook")
      expect(answer.body).not.toContain("abc123")
      expect(typeof echoed === "string" ? echoed : "").not.toContain(secretPathname)
      expect(typeof echoed === "string" ? echoed : "").not.toContain("secret-webhook")
      expect(typeof echoed === "string" ? echoed : "").not.toContain("abc123")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("redacts a destination query echoed without its pathname", async () => {
    const upstream = await listen((request, response) => {
      const search = new URL(request.url ?? "/", "http://upstream.invalid").search
      response.writeHead(200, { "x-echo-search": search })
      response.end(`search=${search}`)
    })
    const secretSearch = "?token=query-secret-zzz"
    const destination = `${upstream.origin}/webhook${secretSearch}`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      const echoed = answer.headers["x-echo-search"]
      expect(answer.status).toBe(200)
      expect(answer.body).not.toContain(secretSearch)
      expect(answer.body).not.toContain("query-secret-zzz")
      expect(typeof echoed === "string" ? echoed : "").not.toContain(secretSearch)
      expect(typeof echoed === "string" ? echoed : "").not.toContain("query-secret-zzz")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("redacts a full absolute destination URL", async () => {
    let destination = ""
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "x-echo-destination": destination })
      response.end(destination)
    })
    destination = `${upstream.origin}/secret-webhook/full-url?token=full-secret`
    const vault = SecretProxy.makeVault({ read: () => destination })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      const echoed = answer.headers["x-echo-destination"]
      expect(answer.status).toBe(200)
      expect(answer.body).not.toContain(destination)
      expect(answer.body).not.toContain("full-secret")
      expect(typeof echoed === "string" ? echoed : "").not.toContain(destination)
      expect(typeof echoed === "string" ? echoed : "").not.toContain("full-secret")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("does not redact a bare slash for a destination without a query", async () => {
    const body = "slashes / stay / unchanged"
    const upstream = await listen((_request, response) => response.end(body))
    const vault = SecretProxy.makeVault({ read: () => `${upstream.origin}/` })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const capability = proxy.urlFor(Secret.Secret("PROXY_DESTINATION_URL"))
      const answer = await get(capability)
      expect(answer.status).toBe(200)
      expect(answer.body).toBe(body)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

const throughProxy = (
  proxy: SecretProxy.Proxy,
  absoluteUrl: string,
  headers: Record<string, string>
): Promise<Answer> =>
  new Promise<Answer>((resolve, reject) => {
    const endpoint = new URL(proxy.endpoint)
    const outgoing = NodeHttp.request({
      host: endpoint.hostname,
      port: Number(endpoint.port),
      method: "GET",
      path: absoluteUrl,
      headers
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }))
    })
    outgoing.on("error", reject)
    outgoing.end()
  })

describe("secret values a request target cannot carry verbatim", () => {
  const placeholderIn = (vault: SecretProxy.Vault, origin: string) =>
    vault.mint(Secret.HttpSecret(Secret.Secret("PROXY_TEST_TOKEN"), [origin]))

  it("percent-encodes a space-bearing secret into the path instead of throwing", async () => {
    let seenPath = ""
    const upstream = await listen((request, response) => {
      seenPath = request.url ?? ""
      response.end("ok")
    })
    const vault = SecretProxy.makeVault({ read: () => "value with space" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/x/${placeholder}`, {})
      expect(answer.status).toBe(200)
      expect(answer.body).toBe("ok")
      expect(seenPath).toBe("/x/value%20with%20space")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("percent-encodes a non-Latin-1 secret into the path instead of throwing", async () => {
    let seenPath = ""
    const upstream = await listen((request, response) => {
      seenPath = request.url ?? ""
      response.end("ok")
    })
    const vault = SecretProxy.makeVault({ read: () => "héllo" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/x/${placeholder}`, {})
      expect(answer.status).toBe(200)
      expect(seenPath).toBe(`/x/${encodeURIComponent("héllo")}`)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("answers 502, naming the declaration only, when a secret cannot cross a header boundary", async () => {
    const upstream = await listen((_request, response) => response.end("ok"))
    // U+2192 is above the Latin-1 range every HTTP header value is bounded to,
    // so the client rejects the header the substituted value produced.
    const vault = SecretProxy.makeVault({ read: () => "token→value" })
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const placeholder = placeholderIn(vault, upstream.origin)
      const answer = await throughProxy(proxy, `${upstream.origin}/plain`, {
        authorization: `Bearer ${placeholder}`
      })
      expect(answer.status).toBe(502)
      expect(answer.body).toContain("PROXY_TEST_TOKEN")
      expect(answer.body).not.toContain("token→value")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe("proxy hop-by-hop headers", () => {
  it("strips a child-nominated header before forwarding the request", async () => {
    let received: NodeHttp.IncomingHttpHeaders = {}
    const upstream = await listen((request, response) => {
      received = request.headers
      response.end("ok")
    })
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    try {
      const answer = await throughProxy(proxy, `${upstream.origin}/check`, {
        connection: "x-private-hop",
        "x-private-hop": "never-forward",
        "x-public": "retain"
      })
      expect(answer.status).toBe(200)
      expect(answer.body).toBe("ok")
      expect(received["x-private-hop"]).toBeUndefined()
      expect(received["x-public"]).toBe("retain")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("accepts a 16 MiB chunked body and rejects the next byte without contacting upstream", async () => {
    const received: Array<number> = []
    const upstream = await listen((request, response) => {
      let bytes = 0
      request.on("data", (chunk: Buffer) => bytes += chunk.byteLength)
      request.on("end", () => {
        received.push(bytes)
        response.end("accepted")
      })
    })
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    const post = (bytes: number): Promise<Answer> =>
      new Promise((resolve, reject) => {
        const endpoint = new URL(proxy.endpoint)
        let answer: Answer | undefined
        const outgoing = NodeHttp.request({
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: "POST",
          path: `${upstream.origin}/upload`,
          headers: { "transfer-encoding": "chunked" }
        }, (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () =>
            answer = {
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers
            })
        })
        outgoing.on("error", (cause: NodeJS.ErrnoException) => {
          if (cause.code !== "EPIPE") reject(cause)
        })
        outgoing.on("close", () =>
          answer === undefined ? reject(new Error("proxy closed without a response")) : resolve(answer))
        outgoing.end(Buffer.alloc(bytes, 0x78))
      })
    try {
      expect(await post(16 * 1024 * 1024)).toMatchObject({ status: 200, body: "accepted" })
      expect(received).toEqual([16 * 1024 * 1024])
      expect(await post(16 * 1024 * 1024 + 1)).toMatchObject({
        status: 413,
        body: "proxy request body is too large"
      })
      expect(received).toEqual([16 * 1024 * 1024])
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe("proxy connection cleanup", () => {
  it("closes an in-flight upstream request when the child disconnects", async () => {
    let upstreamArrived!: () => void
    const arrived = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("upstream request never arrived")), 2_000)
      upstreamArrived = () => {
        clearTimeout(deadline)
        resolve()
      }
    })
    void arrived.catch(() => {})
    let upstreamClosed: Promise<void> | undefined
    const upstream = await listen((request, _response) => {
      upstreamClosed = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("upstream socket stayed open")), 2_000)
        request.socket.once("close", () => {
          clearTimeout(deadline)
          resolve()
        })
      })
      void upstreamClosed.catch(() => {})
      upstreamArrived()
    })
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault())
    let outgoing: NodeHttp.ClientRequest | undefined
    try {
      const endpoint = new URL(proxy.endpoint)
      outgoing = NodeHttp.request({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        path: `${upstream.origin}/pending`
      })
      outgoing.on("error", () => {})
      outgoing.end()
      await arrived
      outgoing.destroy()
      expect(upstreamClosed).toBeDefined()
      await upstreamClosed
    } finally {
      outgoing?.destroy()
      await proxy.close()
      await upstream.close()
    }
  })
})

const exchange = (
  endpoint: string,
  path: string,
  method: string,
  body: Buffer = Buffer.alloc(0)
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const url = new URL(endpoint)
    const outgoing = NodeHttp.request({
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      headers: { "content-length": String(body.byteLength) }
    }, (response) => {
      const chunks: Array<Buffer> = []
      response.on("error", reject)
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }))
    })
    outgoing.on("error", reject)
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("proxy request timed out")))
    outgoing.end(body)
  })

describe.each(["proxy", "destination", "origin"] as const)("%s response and upload integrity", (route) => {
  const requestRoute = async (proxy: SecretProxy.Proxy, origin: string) => {
    if (route === "proxy") return { endpoint: proxy.endpoint, path: `${origin}/upload` }
    if (route === "origin") return { endpoint: await proxy.originFor(origin), path: "/upload" }
    const capability = new URL(proxy.urlFor(Secret.Secret("UPLOAD_DESTINATION")))
    return { endpoint: capability.origin, path: capability.pathname }
  }

  it.each([
    { label: "equal-length decoding", bytes: [0x41, 0xf0, 0x90, 0x80, 0x42] },
    { label: "expanded decoding", bytes: [0x00, 0xed, 0xa0, 0x80, 0xff] }
  ])("forwards invalid UTF-8 upload bytes unchanged: $label", async ({ bytes }) => {
    const body = Buffer.from(bytes)
    let received = Buffer.alloc(0)
    const upstream = await listen((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        received = Buffer.concat(chunks)
        response.end("accepted")
      })
    })
    const vault = SecretProxy.makeVault({ read: () => `${upstream.origin}/upload` })
    vault.mint(Secret.HttpSecret(Secret.Secret("UPLOAD_TOKEN"), [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const target = await requestRoute(proxy, upstream.origin)
      const answer = await exchange(target.endpoint, target.path, "POST", body)
      expect(answer).toMatchObject({ status: 200, body: "accepted" })
      expect(received).toEqual(body)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("still substitutes placeholders in valid UTF-8 uploads and updates their length", async () => {
    const received: Array<Buffer> = []
    let length: string | undefined
    const upstream = await listen((request, response) => {
      length = request.headers["content-length"]
      request.on("data", (chunk: Buffer) => received.push(chunk))
      request.on("end", () => response.end("accepted"))
    })
    const vault = SecretProxy.makeVault({
      read: (name) => name === "UPLOAD_DESTINATION" ? `${upstream.origin}/upload` : "upload-token"
    })
    const placeholder = vault.mint(Secret.HttpSecret(Secret.Secret("UPLOAD_TOKEN"), [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const target = await requestRoute(proxy, upstream.origin)
      expect(await exchange(target.endpoint, target.path, "POST", Buffer.from(`héllo ${placeholder}`)))
        .toMatchObject({ status: 200, body: "accepted" })
      const expected = Buffer.from("héllo upload-token")
      expect(Buffer.concat(received)).toEqual(expected)
      expect(length).toBe(String(expected.byteLength))
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it.each(
    [
      ["HEAD", 200, "12345", false],
      ["HEAD", 200, undefined, false],
      ["HEAD", 200, "12345", true],
      ["GET", 304, "12345", false],
      ["GET", 304, undefined, false],
      ["GET", 304, "12345", true]
    ] as const
  )("preserves %s %s length %s with hop nomination %s", async (method, status, length, nominated) => {
    const upstream = await listen((_request, response) => {
      response.writeHead(status, {
        ...(length === undefined ? {} : { "content-length": length }),
        ...(nominated ? { connection: "content-length" } : {})
      })
      response.end()
    })
    const vault = SecretProxy.makeVault({ read: () => `${upstream.origin}/upload` })
    vault.mint(Secret.HttpSecret(Secret.Secret("UPLOAD_TOKEN"), [upstream.origin]))
    const proxy = await SecretProxy.startProxy(vault)
    try {
      const target = await requestRoute(proxy, upstream.origin)
      const answer = await exchange(target.endpoint, target.path, method)
      expect(answer.status).toBe(status)
      expect(answer.body).toBe("")
      expect(answer.headers["content-length"]).toBe(nominated ? undefined : length)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})

describe("single-pass redaction", () => {
  it.each(["/s", "/.well-known", "/1"])("keeps the capability URL usable when the secret path is %s", async (path) => {
    let destination = ""
    const upstream = await listen((_request, response) => {
      response.writeHead(302, { location: destination, "content-length": String(Buffer.byteLength(destination)) })
      response.end(destination)
    })
    destination = `${upstream.origin}${path}`
    const proxy = await SecretProxy.startProxy(SecretProxy.makeVault({ read: () => destination }))
    try {
      const capability = proxy.urlFor(Secret.Secret("SHORT_PATH_DESTINATION"))
      const answer = await get(capability)
      expect(answer.status).toBe(302)
      expect(answer.headers.location).toBe(capability)
      expect(answer.body).toBe(capability)
      expect(answer.headers["content-length"]).toBe(String(Buffer.byteLength(capability)))
      expect((await get(answer.headers.location!)).body).toBe(capability)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  it("matches original text left to right, chooses the longest match, and treats metacharacters literally", () => {
    const boundary = SecretProxy.makeVault().request("http://upstream.invalid", [
      { value: "abc", placeholder: "short" },
      { value: "abcdef", placeholder: "abc-long" },
      { value: "bcdefg", placeholder: "overlap" },
      { value: "[a].*+$?^{}()|\\", placeholder: "literal" }
    ])
    const text = "abcdefg abc [a].*+$?^{}()|\\ unmatched"
    const expected = "abc-longg short literal unmatched"
    expect(boundary.redact(text)).toBe(expected)
    const invalid = Buffer.from([0xf0, 0x90, 0x80, 0x00, 0xff])
    expect(boundary.redactBytes(Buffer.concat([invalid, Buffer.from(text), invalid])))
      .toEqual(Buffer.concat([invalid, Buffer.from(expected), invalid]))
    expect(boundary.redactBytes(Buffer.alloc(0))).toEqual(Buffer.alloc(0))
  })

  it("handles many short matches with absent URL protections without changing inserted capabilities", () => {
    const capability = "http://127.0.0.1:1234/.well-known/smithers-secret-url/capability"
    const boundary = SecretProxy.makeVault().request("http://upstream.invalid", [
      { value: "https://upstream.invalid/s", placeholder: capability },
      { value: "https://upstream.invalid", placeholder: "http://127.0.0.1:1234" },
      { value: "/s", placeholder: capability }
    ])
    const repetitions = 16_384
    expect(boundary.redactBytes(Buffer.from("/s".repeat(repetitions) + "tail")).toString("utf8"))
      .toBe(capability.repeat(repetitions) + "tail")
  })

  it("redacts Unicode, repeated adjacent matches, and values resolved after the boundary was opened", () => {
    const vault = SecretProxy.makeVault({ read: () => "éclair" })
    const boundary = vault.request("https://upstream.invalid", [{ value: "", placeholder: "ignored" }])
    expect(boundary.redact("untouched")).toBe("untouched")
    expect(boundary.redactBytes(Buffer.from("untouched"))).toEqual(Buffer.from("untouched"))
    const placeholder = vault.mint(Secret.HttpSecret(Secret.Secret("LATE_TOKEN"), ["https://upstream.invalid"]))
    boundary.substitute(placeholder)
    expect(boundary.redact("éclairéclair")).toBe(placeholder.repeat(2))
    expect(boundary.redactBytes(Buffer.from("éclairéclair"))).toEqual(Buffer.from(placeholder.repeat(2)))
    const seeded = vault.request("https://upstream.invalid", [{ value: "éclair", placeholder: "seed" }])
    expect(seeded.redact("éclair")).toBe("seed")
    expect(seeded.redactBytes(Buffer.from("éclair"))).toEqual(Buffer.from("seed"))
  })
})
