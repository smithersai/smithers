import { Effect, Fiber, Redacted } from "effect"
import * as Result from "effect/Result"
import { describe, expect, test } from "vitest"
import { GitRemote } from "../src/index.ts"
import { brokenBody, growth, httpClient, telemetry } from "./fixtures.ts"

// A scripted git host on the `fetch` seam, answering `info/refs` the way GitHub does (checked against
// github.com/octocat/Spoon-Knife on 2026-10-19): the service line, a flush, then HEAD with its capabilities.

const SHA = "d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9"
const ADVERTISEMENT = "application/x-git-upload-pack-advertisement"

const encoder = new TextEncoder()
/** A pkt-line: its 4-hex-digit length counts the line's UTF-8 bytes plus the 4 of the length itself. */
const pkt = (line: string) => `${(encoder.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`
/** A pkt-line from raw payload bytes, which need not be UTF-8. */
const rawPkt = (payload: Uint8Array) =>
  new Uint8Array([...encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), ...payload])
const advertisement = (...refs: Array<string>) =>
  `${pkt("# service=git-upload-pack\n")}0000${refs.map(pkt).join("")}0000`
const headLine = (capabilities: string, sha = SHA) =>
  `${sha} HEAD\0multi_ack thin-pack side-band ofs-delta ${capabilities} agent=git/github\n`

/** Bytes as a stream of `size`-byte chunks, then (when `endless`) chunks of more refs forever, counted in `extra`. */
const trickle = (text: string | Uint8Array, endless = false, size = 1) => {
  const bytes = typeof text === "string" ? encoder.encode(text) : text
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (index < bytes.length) controller.enqueue(bytes.subarray(index, index += size))
      else if (endless) {
        stream.extra++
        controller.enqueue(encoder.encode(pkt(`${SHA} refs/pull/1/head\n`)))
      } else controller.close()
    }
  }) as ReadableStream<Uint8Array> & { extra: number }
  stream.extra = 0
  return stream
}

/** Bytes as a stream of chunks cut at the byte offsets `cuts`, which may fall inside a header or a code point. */
const cutAt = (bytes: Uint8Array, ...cuts: Array<number>) => {
  const bounds = [0, ...cuts, bytes.length]
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (let index = 1; index < bounds.length; index++) {
        controller.enqueue(bytes.slice(bounds[index - 1], bounds[index]))
      }
      controller.close()
    }
  })
}

const host = (answer: (url: URL) => Response | "throw") => {
  const seen: Array<URL> = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    seen.push(url)
    const response = answer(url)
    if (response === "throw") throw new TypeError("fetch failed")
    return response
  }
  return { fetch, seen }
}

const read = (answer: (url: URL) => Response | "throw", remote = "https://github.com/octocat/Spoon-Knife.git") => {
  const { fetch, seen } = host(answer)
  const recorded = telemetry()
  const run = Effect.runPromise(
    recorded.provide(Effect.result(GitRemote.head(remote)).pipe(Effect.provide(httpClient(fetch))))
  )
  return { run, seen, recorded }
}

const ok = (body: string | ReadableStream<Uint8Array>, type = ADVERTISEMENT) =>
  new Response(body, { status: 200, headers: { "content-type": type } })

describe("GitRemote.head", () => {
  test("reads HEAD's commit and branch from the first ref line, asking for upload-pack's advertisement", async () => {
    const { run, seen, recorded } = read(
      () => ok(advertisement(headLine("symref=HEAD:refs/heads/main"))),
      "https://github.com/o/n.git/"
    )
    expect(await run).toMatchObject({ _tag: "Success", success: { sha: SHA, branch: "main" } })
    expect(seen[0]!.href).toBe("https://github.com/o/n.git/info/refs?service=git-upload-pack")
    expect(recorded.count(GitRemote.requests, { outcome: "ok" })).toBe(1)
    const span = recorded.spans.find((each) => each.name === "GitRemote.head")!
    expect(span.attributes.get("git.remote")).toBe("https://github.com/o/n.git/")
  })

  test("a branch name with slashes, and a SHA-256 repository", async () => {
    const sha256 = "a".repeat(64)
    const { run } = read(() => ok(advertisement(headLine("symref=HEAD:refs/heads/release/1.0", sha256))))
    expect(await run).toMatchObject({ success: { sha: sha256, branch: "release/1.0" } })
  })

  test("Unicode branch names frame by bytes, however the network cuts the advertisement", async () => {
    // Pkt-line lengths count bytes. Each branch below is longer in UTF-8 bytes than in JavaScript string units, and
    // the next ref packet sits right behind HEAD, so framing by string offsets would cut HEAD short or eat that packet.
    for (const branch of ["日本語", "feature/🚀", "cafe\u0301", "e\u0301\u0301x", "a\u3000b", "a\u00a0b"]) {
      const body = encoder.encode(
        advertisement(headLine(`symref=HEAD:refs/heads/${branch}`), `${SHA} refs/heads/${branch}\n`)
      )
      const expected = { success: { sha: SHA, branch } }
      expect(await read(() => ok(cutAt(body))).run, branch).toMatchObject(expected)
      expect(await read(() => ok(trickle(new TextDecoder().decode(body)))).run, branch).toMatchObject(expected)
      // Two chunks, cut at every byte offset: inside a length header, inside a code point, on a packet boundary.
      for (let cut = 1; cut < body.length; cut++) {
        expect(await read(() => ok(cutAt(body, cut))).run, `${branch} cut at ${cut}`).toMatchObject(expected)
      }
    }
  })

  test("a packet that isn't UTF-8 is invalid_response; a packet after HEAD is never decoded", async () => {
    const flush = encoder.encode("0000")
    /** An advertisement whose HEAD line holds `bytes` where the branch goes, framed by their true length. */
    const rawHead = (...bytes: Array<number>) =>
      new Uint8Array([
        ...encoder.encode(`${pkt("# service=git-upload-pack\n")}0000`),
        ...rawPkt(new Uint8Array([...encoder.encode(`${SHA} HEAD\0symref=HEAD:refs/heads/`), ...bytes, 0x0a])),
        ...flush
      ])
    const bodies = [
      // A lone continuation byte, an invalid lead byte, and a code point cut short inside a whole packet.
      rawHead(0x80),
      rawHead(0xff),
      rawHead(...encoder.encode("日").subarray(0, 2)),
      // The service line itself isn't UTF-8.
      new Uint8Array([...rawPkt(new Uint8Array([...encoder.encode("# service=git-upload-pack"), 0xc3])), ...flush])
    ]
    for (const body of bodies) {
      for (const stream of [cutAt(body), cutAt(body, body.length - 7)]) {
        const { run, recorded } = read(() => ok(stream))
        expect(await run).toMatchObject({ failure: { code: "invalid_response", status: 200 } })
        expect(recorded.count(GitRemote.requests, { outcome: "invalid_response" })).toBe(1)
      }
    }
    const later = new Uint8Array([
      ...encoder.encode(`${pkt("# service=git-upload-pack\n")}0000${pkt(headLine("symref=HEAD:refs/heads/main"))}`),
      ...rawPkt(new Uint8Array([...encoder.encode(`${SHA} refs/heads/`), 0xff, 0x0a])),
      ...flush
    ])
    expect(await read(() => ok(cutAt(later))).run).toMatchObject({ success: { sha: SHA, branch: "main" } })
  })

  test("a detached HEAD has no branch", async () => {
    const { run } = read(() => ok(advertisement(headLine("ofs-delta"))))
    expect(await run).toMatchObject({ success: { sha: SHA, branch: undefined } })
  })

  test("stops reading after the first ref line, so an endless advertisement answers after reading HEAD", async () => {
    const body = trickle(advertisement(headLine("symref=HEAD:refs/heads/main")).slice(0, -4), true)
    const { run } = read(() => ok(body))
    expect(await run).toMatchObject({ success: { sha: SHA, branch: "main" } })
    // The stream reads ahead at most a chunk or two past HEAD, never the 64 KiB cap's worth of refs.
    expect(body.extra).toBeLessThanOrEqual(2)
  })

  test("a repository with no commits, no refs, or refs but no HEAD is empty", async () => {
    const zero = "0".repeat(40)
    for (
      const body of [
        advertisement(`${zero} capabilities^{}\0multi_ack\n`),
        advertisement(),
        advertisement(`${SHA} refs/heads/main\0multi_ack\n`)
      ]
    ) {
      const { run, recorded } = read(() => ok(body))
      expect(await run).toMatchObject({ failure: { code: "empty", status: 200 } })
      expect(recorded.count(GitRemote.requests, { outcome: "empty" })).toBe(1)
    }
  })

  test("401, 403 and 404 are not_found; another failing status is unavailable with the status", async () => {
    for (const status of [401, 403, 404]) {
      const { run } = read(() => new Response("Repository not found.", { status }))
      expect(await run).toMatchObject({ failure: { code: "not_found", status } })
    }
    const { run } = read(() => new Response(null, { status: 502 }))
    const failure = (await run as { failure: GitRemote.GitRemoteError }).failure
    expect(failure).toMatchObject({ code: "unavailable", status: 502 })
    expect(failure.message).toBe("git remote: unavailable (502)")
  })

  test("an answer that isn't a smart HTTP advertisement is invalid_response", async () => {
    const bodies: Array<Response> = [
      ok(advertisement(headLine("")), "text/plain"),
      new Response(trickle(advertisement(headLine(""))), { status: 200 }),
      ok("zzzz"),
      ok("0002"),
      ok(`${pkt("not the service\n")}0000`),
      ok(`0000${pkt("# service=git-upload-pack\n")}`),
      ok(`${pkt("# service=git-upload-pack\n")}${pkt("x\n")}`),
      ok(`${pkt("# service=git-upload-pack\n")}0000${pkt("not a ref line\n")}`),
      // A byte order mark is kept, not stripped, so it can't pass for the service line.
      ok(`${pkt("\ufeff# service=git-upload-pack\n")}0000${pkt(headLine(""))}0000`)
    ]
    for (const body of bodies) {
      const { run } = read(() => body)
      expect(await run).toMatchObject({ failure: { code: "invalid_response" } })
    }
  })

  test("an advertisement whose HEAD line doesn't arrive inside the 64 KiB cap is too_large", async () => {
    const { run, recorded } = read(() =>
      ok(trickle(`${pkt("# service=git-upload-pack\n")}0000fff0${"a".repeat(70_000)}`, false, 4096))
    )
    expect(await run).toMatchObject({ failure: { code: "too_large", status: 200 } })
    expect(recorded.count(GitRemote.requests, { outcome: "too_large" })).toBe(1)
  })

  test("an advertisement that ends before HEAD, at each step, is invalid_response", async () => {
    for (const body of ["", pkt("# service=git-upload-pack\n"), `${pkt("# service=git-upload-pack\n")}0000`]) {
      const { run } = read(() => ok(body))
      expect(await run).toMatchObject({ failure: { code: "invalid_response" } })
    }
  })

  test("no answer, or an answer that breaks off, is transport", async () => {
    const thrown = read(() => "throw")
    expect(await thrown.run).toMatchObject({ failure: { code: "transport" } })
    expect((await thrown.run as { failure: GitRemote.GitRemoteError }).failure.message).toBe("git remote: transport")
    const broken = read(() => ok(brokenBody("001e")))
    expect(await broken.run).toMatchObject({ failure: { code: "transport", status: 200 } })
  })

  test("a read interrupted mid-flight counts as interrupted", async () => {
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (started = resolve))
    const fetch: typeof globalThis.fetch = (input) =>
      new Promise<Response>((_, reject) => {
        started()
        ;(input as Request).signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const recorded = telemetry()
    await Effect.runPromise(recorded.provide(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(GitRemote.head("https://github.com/o/n.git"))
        yield* Effect.promise(() => waiting)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(httpClient(fetch)))
    ))
    expect(recorded.count(GitRemote.requests, { outcome: "interrupted" })).toBe(1)
  })
})

describe("GitRemote.ref", () => {
  const OTHER = "1111111111111111111111111111111111111111"
  const RESULT = "application/x-git-upload-pack-result"
  /** An ls-refs answer listing `refs`, then a flush, as GitHub answers (checked 2026-10-20). */
  const listed = (...refs: Array<string>) => `${refs.map(pkt).join("")}0000`
  const answer = (body: string | ReadableStream<Uint8Array>, type = RESULT) =>
    new Response(body, { status: 200, headers: { "content-type": type } })
  const readRef = (
    respond: (request: Request, body: string) => Response | "throw",
    branch: string,
    authorization?: string
  ) => {
    const seen: Array<{ readonly request: Request; readonly body: string }> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const body = await request.text()
      seen.push({ request, body })
      const response = respond(request, body)
      if (response === "throw") throw new TypeError("fetch failed")
      return response
    }
    const recorded = telemetry()
    const upstream = {
      url: "https://git.example/acme/repo.git/",
      ...(authorization === undefined ? {} : { authorization: Redacted.make(authorization) })
    }
    const run = Effect.runPromise(
      recorded.provide(Effect.result(GitRemote.ref(upstream, branch)).pipe(Effect.provide(httpClient(fetch))))
    )
    return { run, seen, recorded }
  }

  test("asks ls-refs for that one branch with the upstream's credential, and records neither", async () => {
    const { run, seen, recorded } = readRef(
      () => answer(listed(`${OTHER} refs/heads/feature/x\n`)),
      "feature/x",
      "Basic c2VjcmV0"
    )
    expect(await run).toEqual(Result.succeed(OTHER))
    const { request, body } = seen[0]!
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://git.example/acme/repo.git/git-upload-pack")
    expect(request.headers.get("git-protocol")).toBe("version=2")
    expect(request.headers.get("content-type")).toBe("application/x-git-upload-pack-request")
    expect(request.headers.get("authorization")).toBe("Basic c2VjcmV0")
    expect(body).toBe(`${pkt("command=ls-refs\n")}0001${pkt("ref-prefix refs/heads/feature/x\n")}0000`)
    expect(recorded.recorded()).not.toContain("c2VjcmV0")
    expect(recorded.count(GitRemote.requests, { outcome: "ok" })).toBe(1)
    expect(recorded.spans.map((span) => span.name)).toContain("GitRemote.ref")
  })

  test("takes the exact ref among those the prefix lists, with attributes, across chunks, and no credential", async () => {
    const { run, seen } = readRef(
      () =>
        answer(trickle(listed(`${OTHER} refs/heads/main-old\n`, `${SHA} refs/heads/main symref-target:x\n`), false, 5)),
      "main"
    )
    expect(await run).toEqual(Result.succeed(SHA))
    expect(seen[0]!.request.headers.get("authorization")).toBeNull()
  })

  test("Unicode branch names frame by bytes, however the network cuts the answer", async () => {
    for (const branch of ["日本語", "feature/🚀", "cafe\u0301", "a\u3000b"]) {
      const body = encoder.encode(listed(`${OTHER} refs/heads/${branch}-old\n`, `${SHA} refs/heads/${branch}\n`))
      for (let cut = 1; cut < body.length; cut++) {
        const { run } = readRef(() => answer(cutAt(body, cut)), branch)
        expect(await run, `${branch} cut at ${cut}`).toEqual(Result.succeed(SHA))
      }
      expect(await readRef(() => answer(trickle(body)), branch).run, branch).toEqual(Result.succeed(SHA))
    }
  })

  test("stops reading at the wanted ref, so an endless answer answers once that ref arrives", async () => {
    const body = trickle(pkt(`${OTHER} refs/heads/main\n`), true)
    const { run } = readRef(() => answer(body), "main")
    expect(await run).toEqual(Result.succeed(OTHER))
    // The stream reads ahead at most a chunk or two past the ref, never the 1 MiB cap's worth of refs.
    expect(body.extra).toBeLessThanOrEqual(2)
  })

  test("an answer that passes the 1 MiB cap before the ref or the flush is too_large", async () => {
    const body = trickle(pkt(`${OTHER} refs/heads/main-old\n`), true)
    const { run, recorded } = readRef(() => answer(body), "main")
    const result = await run
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "too_large", status: 200 })
    expect(recorded.count(GitRemote.requests, { outcome: "too_large" })).toBe(1)
    expect(body.extra * pkt(`${SHA} refs/pull/1/head\n`).length).toBeLessThan(1024 * 1024 + 1024)
  })

  // "ref-prefix refs/heads/" and the newline are 23 bytes, so a branch of 65,493 bytes fills git's largest pkt-line
  // (65,520 bytes with its four length digits) exactly.
  test.each(
    [
      ["ASCII", "a".repeat(65_493)],
      ["multibyte", "a" + "\u00e9".repeat(32_746)]
    ] as const
  )("frames the largest %s branch one pkt-line holds, its header the real byte count", async (_name, branch) => {
    expect(encoder.encode(branch).length).toBe(65_493)
    const { run, seen } = readRef(() => answer(listed()), branch)
    expect(await run).toMatchObject({ failure: { code: "ref_not_found" } })
    const sent = encoder.encode(seen[0]!.body)
    const line = sent.subarray("0014command=ls-refs\n0001".length, sent.length - 4)
    expect(line.length).toBe(65_520)
    expect(new TextDecoder().decode(line.subarray(0, 4))).toBe("fff0")
    expect(new TextDecoder().decode(line.subarray(4))).toBe(`ref-prefix refs/heads/${branch}\n`)
    expect(seen[0]!.body.endsWith("\n0000")).toBe(true)
  })

  test.each(
    [
      ["ASCII", "a".repeat(65_494)],
      ["multibyte", "aa" + "\u00e9".repeat(32_746)],
      ["far past the cap", "\u00e9".repeat(200_000)]
    ] as const
  )("a branch one byte past the largest pkt-line (%s) is invalid_argument and sends nothing", async (_name, branch) => {
    const { run, seen, recorded } = readRef(() => answer(listed()), branch, "Basic c2VjcmV0")
    const result = await run
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "invalid_argument" })
    expect(Result.isFailure(result) && result.failure.status).toBeUndefined()
    expect(seen).toEqual([])
    expect(recorded.count(GitRemote.requests, { outcome: "invalid_argument" })).toBe(1)
    expect(recorded.spans.find((span) => span.name === "GitRemote.ref")?.status._tag).toBe("Ended")
  })

  test("reading an answer costs time linear in its refs, however finely the network cuts it", async () => {
    const refs = (n: number) =>
      encoder.encode(listed(...Array.from({ length: n }, (_, index) => `${SHA} refs/pull/${index}/head\n`)))
    const lookup = async (n: number) => {
      const body = refs(n)
      const result = await readRef(() => answer(trickle(body, false, 1024)), "main").run
      expect(Result.isFailure(result) && result.failure.code).toBe("ref_not_found")
    }
    // 3,000 refs, then 12,000 (about 780 KB), in 1 KiB chunks: linear grows about 4x; re-parsing every chunk read so
    // far grows about 16x.
    expect(await growth(lookup, 3_000)).toBeLessThan(8)
  })

  const failures: ReadonlyArray<readonly [string, () => Response | "throw", string, string]> = [
    ["a branch the remote doesn't have", () => answer("0000"), "nope", "ref_not_found"],
    [
      "only a longer name under the prefix",
      () => answer(listed(`${OTHER} refs/heads/nope-2\n`)),
      "nope",
      "ref_not_found"
    ],
    ["a missing repository", () => new Response("", { status: 404 }), "main", "not_found"],
    ["a refused credential", () => new Response("", { status: 401 }), "main", "not_found"],
    ["a forbidden repository", () => new Response("", { status: 403 }), "main", "not_found"],
    ["a failing remote", () => new Response("", { status: 503 }), "main", "unavailable"],
    ["no answer", () => "throw" as const, "main", "transport"],
    ["another content type", () => answer(listed(`${SHA} refs/heads/main\n`), "text/html"), "main", "invalid_response"],
    ["no content type", () => new Response(encoder.encode("0000"), { status: 200 }), "main", "invalid_response"],
    ["an answer with no end", () => answer(pkt(`${SHA} refs/heads/main-2\n`)), "main", "invalid_response"],
    ["a malformed packet header", () => answer("zzzz"), "main", "invalid_response"],
    ["a malformed ref line", () => answer(listed("not a ref\n")), "main", "invalid_response"],
    [
      "a ref that isn't UTF-8",
      () => answer(new Blob([rawPkt(new Uint8Array([0xff, 0xfe])), encoder.encode("0000")]).stream()),
      "main",
      "invalid_response"
    ],
    ["a body that breaks off", () => answer(brokenBody(pkt(`${SHA} refs/heads/other\n`))), "main", "transport"]
  ]
  test.each(failures)("fails on %s", async (_, respond, branch, code) => {
    const { run, recorded } = readRef(respond, branch)
    const result = await run
    expect(Result.isFailure(result) && result.failure.code).toBe(code)
    expect(recorded.count(GitRemote.requests, { outcome: code })).toBe(1)
  })
})

describe("GitRemote.head with an upstream", () => {
  test("sends the upstream's credential and records only its URL", async () => {
    const seen: Array<Request> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      seen.push(request)
      return ok(advertisement(headLine("symref=HEAD:refs/heads/main")))
    }
    const recorded = telemetry()
    const result = await Effect.runPromise(recorded.provide(
      Effect.result(
        GitRemote.head({ url: "https://acme.code.storage/r.git", authorization: Redacted.make("Basic eDp5") })
      )
        .pipe(Effect.provide(httpClient(fetch)))
    ))
    expect(result).toMatchObject({ success: { sha: SHA, branch: "main" } })
    expect(seen[0]!.headers.get("authorization")).toBe("Basic eDp5")
    const span = recorded.spans.find((each) => each.name === "GitRemote.head")!
    expect(span.attributes.get("git.remote")).toBe("https://acme.code.storage/r.git")
    expect(recorded.recorded()).not.toContain("eDp5")
  })
})

describe("redirects", () => {
  const moved = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/r.git" } })
  /** A host that answers every request with a redirect, and the fetch options each request arrived with. */
  const redirecting = () => {
    const seen: Array<{ readonly url: string; readonly redirect: RequestRedirect | undefined }> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ url: String(input), redirect: init?.redirect })
      return moved()
    }
    return { fetch, seen }
  }
  const upstream = { url: "https://acme.code.storage/r.git", authorization: Redacted.make("Basic eDp5") }

  test.each(
    [
      ["head", () => Effect.asVoid(GitRemote.head(upstream))],
      ["ref", () => Effect.asVoid(GitRemote.ref(upstream, "main"))]
    ] as const
  )("%s with a credential never follows a redirect: one request, then unavailable", async (_name, call) => {
    const { fetch, seen } = redirecting()
    const result = await Effect.runPromise(Effect.result(call()).pipe(Effect.provide(httpClient(fetch))))
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "unavailable", status: 302 })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.redirect).toBe("manual")
    expect(new URL(seen[0]!.url).origin).toBe("https://acme.code.storage")
  })

  test("head without a credential leaves redirects to the transport, as git clone follows a renamed repository", async () => {
    const { fetch, seen } = redirecting()
    await Effect.runPromise(
      Effect.result(GitRemote.head("https://github.com/o/renamed.git")).pipe(Effect.provide(httpClient(fetch)))
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.redirect).toBeUndefined()
  })
})
