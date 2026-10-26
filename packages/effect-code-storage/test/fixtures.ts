import { Effect, Layer, Logger, Metric, References, Tracer } from "effect"
import * as Base64 from "effect/encoding/Base64"
import * as Base64Url from "effect/encoding/Base64Url"
import { FetchHttpClient } from "effect/http"
import * as Result from "effect/Result"

// A scripted Code Storage: the third-party provider these suites stand in for, scripted at the network (`fetch`) the
// way the app scripts its model. It keeps repositories in memory, answers the documented routes with the documented
// bodies (code.storage/docs/openapi.json, 2026-10-19), and checks every request's JWT exactly as the real service
// would: an ES256 signature from the organization's public key, `iss`, `repo`, the scope the route requires, and a
// lifetime of at most an hour. Faults are injected per request.

export const ORG = "acme"
export const BASE = "https://api.acme.code.storage"

/** A fresh P-256 key pair: the private key as the PKCS#8 PEM the Keys page issues, and the public key to verify. */
export const keyPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const body = Base64.encode(der).match(/.{1,64}/g)!.join("\n")
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey }
}

export interface Claims {
  readonly iss: string
  readonly sub: string
  readonly repo: string
  readonly scopes: ReadonlyArray<string>
  readonly iat: number
  readonly exp: number
}

export interface Seen {
  readonly method: string
  readonly url: URL
  readonly authorization: string | null
  readonly claims: Claims | undefined
  readonly body: unknown
}

export interface Repo {
  upstream?: { readonly owner: string; readonly name: string } | undefined
  defaultBranch: string
  /** Calls left that answer `409 sync_in_progress`. */
  syncing: number
  files: Record<string, Uint8Array>
  commits: Array<Record<string, unknown>>
  /** Branches as Code Storage lists them: `{ name, head_sha, created_at }`. */
  branches: Array<{ name: string; head_sha: string; created_at: string }>
  /** Tags as Code Storage lists them: `{ name, sha }`. */
  tags: Array<{ name: string; sha: string }>
}

/** A response the next matching request gets instead of the service's own answer; `throw` makes `fetch` reject. */
export type Fault = Response | "throw" | ((request: Request) => Response | Promise<Response> | "throw")

const problem = (status: number, code: string, detail = `scripted ${code}`) =>
  Response.json({ type: "about:blank", title: code, status, code, detail, error: detail }, {
    status,
    headers: { "content-type": "application/problem+json" }
  })

const json = (segment: string): any =>
  JSON.parse(new TextDecoder().decode(Result.getOrThrow(Base64Url.decode(segment))))

/** A JWT's claims, unverified. */
export const decodeClaims = (token: string): Claims => json(token.split(".")[1]!)

/** The scripted service: its repositories, every request it saw, and a fault queue. */
export const codeStorage = (publicKey: CryptoKey) => {
  const repos = new Map<string, Repo>()
  const seen: Array<Seen> = []
  const faults: Array<Fault> = []

  const verify = async (header: string | null, repo: string, scope: string): Promise<Response | Claims> => {
    if (header === null || !header.startsWith("Bearer ")) return problem(401, "unauthorized")
    const token = header.slice("Bearer ".length)
    const [h, p, s] = token.split(".")
    const signature = Base64Url.decode(s ?? "")
    if (signature._tag !== "Success") return problem(401, "unauthorized")
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      new Uint8Array(signature.success),
      new TextEncoder().encode(`${h}.${p}`)
    )
    if (!valid) return problem(401, "unauthorized")
    const claims = decodeClaims(token)
    if (json(h!).alg !== "ES256") return problem(401, "unauthorized")
    if (claims.iss !== ORG || claims.exp - claims.iat > 3600) return problem(401, "unauthorized")
    if (claims.repo !== repo) return problem(400, "repo_name_mismatch")
    if (!claims.scopes.includes(scope)) return problem(403, "insufficient_scope")
    return claims
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const text = request.method === "POST" ? await request.text() : ""
    const body = text === "" ? undefined : JSON.parse(text)
    const authorization = request.headers.get("authorization")
    const record = (claims: Claims | undefined) =>
      seen.push({ method: request.method, url, authorization, claims, body })

    const fault = faults.shift()
    if (fault !== undefined) {
      record(authorization === null ? undefined : decodeClaims(authorization.slice(7)))
      const answer = typeof fault === "function" ? await fault(request) : fault
      if (answer === "throw") throw new TypeError("fetch failed")
      return answer
    }

    const route =
      /^\/api\/repos(?:\/([^/]+))?(\/upstream\/pull|\/files|\/file|\/commits|\/branches\/create|\/branches|\/tags)?$/
        .exec(
          url.pathname
        )
    if (route === null || url.origin !== BASE) {
      record(undefined)
      return problem(404, "route_not_found")
    }
    const name = route[1] === undefined ? (body as { repo_name: string }).repo_name : decodeURIComponent(route[1])
    const action = route[2] ?? ""
    const scope = action === ""
      ? "repo:write"
      : action === "/upstream/pull" || action === "/branches/create"
      ? "git:write"
      : "git:read"
    const verified = await verify(authorization, name, scope)
    if (verified instanceof Response) {
      record(undefined)
      return verified
    }
    record(verified)

    if (request.method === "POST" && action === "") {
      const { upstream, default_branch } = body as {
        upstream?: { owner: string; name: string; provider: string; access: string }
        default_branch?: string
      }
      const existing = repos.get(name)
      if (existing !== undefined) {
        if (existing.upstream?.owner !== upstream?.owner || existing.upstream?.name !== upstream?.name) {
          return problem(409, "conflict", `Repository ${name} exists with another upstream`)
        }
        return Response.json({ repo_id: "r", repo_name: name, http_url: name, message: "exists" }, { status: 200 })
      }
      repos.set(name, {
        upstream: upstream === undefined ? undefined : { owner: upstream.owner, name: upstream.name },
        defaultBranch: default_branch ?? "main",
        syncing: 0,
        files: {},
        commits: [],
        branches: [],
        tags: []
      })
      return Response.json({ repo_id: "r", repo_name: name, http_url: name, message: "created" }, { status: 201 })
    }
    const repo = repos.get(name)
    if (repo === undefined) return problem(404, "repository_not_found")
    if (repo.syncing > 0) {
      repo.syncing--
      return problem(409, "sync_in_progress", "repository sync in progress. please retry shortly")
    }
    if (request.method === "POST" && action === "/upstream/pull") {
      return Response.json({ message: "queued" }, { status: 202 })
    }
    if (request.method === "POST" && action === "/branches/create") {
      const { base_ref, target_branch, force } = body as { base_ref: string; target_branch: string; force?: boolean }
      // A ref is a branch's name, or a commit some branch is at.
      const base = repo.branches.find((branch) => branch.name === base_ref) ??
        repo.branches.find((branch) => branch.head_sha === base_ref)
      if (base === undefined) return problem(404, "ref_not_found")
      const existing = repo.branches.findIndex((branch) => branch.name === target_branch)
      if (existing >= 0 && force !== true) {
        return problem(409, "conflict", `Branch ${target_branch} exists`)
      }
      const made = { name: target_branch, head_sha: base.head_sha, created_at: "2026-10-20T18:00:00Z" }
      if (existing >= 0) repo.branches[existing] = made
      else repo.branches.push(made)
      return Response.json({
        message: "created",
        target_branch,
        target_is_ephemeral: false,
        commit_sha: base.head_sha
      })
    }
    if (action === "/files") {
      const all = Object.keys(repo.files).sort()
      const start = Number(url.searchParams.get("cursor") ?? "0")
      const limit = Number(url.searchParams.get("limit") ?? "1000")
      const page = all.slice(start, start + limit)
      const more = start + limit < all.length
      return Response.json({
        paths: page,
        ref: url.searchParams.get("ref") ?? repo.defaultBranch,
        entries: page.map((path) => ({ path, type: "blob", mode: "100644" })),
        has_more: more,
        ...(more ? { next_cursor: String(start + limit) } : {})
      })
    }
    if (action === "/file") {
      const file = repo.files[url.searchParams.get("path") ?? ""]
      if (file === undefined) return problem(404, "not_found")
      return new Response(new Uint8Array(file), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.length),
          "x-blob-sha": "b".repeat(40)
        }
      })
    }
    if (action === "/branches" || action === "/tags") {
      const all = action === "/branches" ? repo.branches : repo.tags
      const start = Number(url.searchParams.get("cursor") ?? "0")
      const limit = Number(url.searchParams.get("limit") ?? "20")
      const page = all.slice(start, start + limit).map((ref, index) => ({ ...ref, cursor: String(start + index) }))
      const more = start + limit < all.length
      return Response.json({
        [action === "/branches" ? "branches" : "tags"]: page,
        has_more: more,
        ...(more ? { next_cursor: String(start + limit) } : {})
      })
    }
    return Response.json({ commits: repo.commits, has_more: false })
  }

  return { fetch, repos, seen, faults }
}

/** A body that streams `size` bytes of `a` in `chunkBytes` chunks, as a long response would arrive. */
export const longBody = (size: number, chunkBytes = 64 * 1024) => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const chunk = Math.min(chunkBytes, size - sent)
      if (chunk <= 0) return controller.close()
      controller.enqueue(new Uint8Array(chunk).fill(97))
      sent += chunk
    }
  })
}

/**
 * How much longer `run(4 * n)` takes than `run(n)`: about 4 when its cost is linear in `n`, about 16 when it is
 * quadratic. Each size runs three times after a warm-up and keeps its fastest, so a pause can't pass for growth.
 */
export const growth = async (run: (n: number) => Promise<unknown>, n: number): Promise<number> => {
  const fastest = async (size: number) => {
    let best = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3; round++) {
      const start = performance.now()
      await run(size)
      best = Math.min(best, performance.now() - start)
    }
    return best
  }
  await run(n)
  return (await fastest(4 * n)) / (await fastest(n))
}

/** A body that sends `first` and then breaks, as a connection reset mid-response would. */
export const brokenBody = (first: string) => {
  let pulls = 0
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(first))
      else controller.error(new Error("connection reset"))
    }
  })
}

/** Everything a program records: its spans (with their attributes and events), log lines and metric registry. */
export const telemetry = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const logs: Array<{ message: unknown; annotations: Record<string, unknown> }> = []
  const registry = new Map()
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const recorder = Logger.make(({ message, fiber }) => {
    logs.push({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Logger.layer([recorder])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  const count = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  /** Every string the program recorded: span names, attributes, events and exits, and log lines. */
  const recorded = () =>
    JSON.stringify([
      spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events,
        status: span.status
      })),
      logs
    ], (_, value) =>
      typeof value === "bigint" ?
        String(value) :
        value instanceof Error ?
        { name: value.name, message: value.message, cause: String(value.cause) } :
        value)
  return { spans, logs, provide, count, recorded }
}

/** The HTTP client the suites run on: Effect's fetch client over the scripted `fetch`. */
export const httpClient = (fetch: typeof globalThis.fetch) =>
  Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))
