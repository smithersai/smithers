import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isFramePath } from "./appDocument"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

/*
 * The site build's public/_redirects ships inside this Worker's assets, so its
 * rules run on every path the assets layer answers, including a path the
 * Worker passes through to `env.ASSETS.fetch` (verified against `wrangler dev`:
 * /workflows/audit, under a run_worker_first prefix the Worker does not
 * handle, still answers its 301). Two things must never be true of the file: a
 * rule that captures a path the app owns (the app document, a frame path, the
 * hashed chunks, the build stamp) would replace the app with a redirect; and a
 * rule under a path the Worker answers itself, never consulting the assets
 * layer for that path (/api/*, a routed owner, a frame path), can never run,
 * so it is a dead rule that reads as live.
 *
 * The parser accepts the two rule shapes the file uses, literal sources and
 * one-splat sources (the same grammar apps/site/scripts/check-built-site.mjs
 * enforces), and throws on anything else rather than skipping it.
 */
interface RedirectRule {
  readonly source: string
  readonly destination: string
  readonly status: string
  readonly pattern: RegExp
  readonly line: number
}

const redirectsPath = fileURLToPath(new URL("../../site/public/_redirects", import.meta.url))

const parseRedirects = (text: string): ReadonlyArray<RedirectRule> =>
  text.split("\n").flatMap((raw, index) => {
    const trimmed = raw.trim()
    if (trimmed === "" || trimmed.startsWith("#")) return []
    const [source, destination, status = "302", extra] = trimmed.split(/\s+/)
    if (source === undefined || destination === undefined || extra !== undefined || source.split("*").length > 2) {
      throw new Error(`_redirects:${index + 1}: unsupported redirect: ${trimmed}`)
    }
    const pattern = new RegExp(
      `^${source.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*)")}$`
    )
    return [{ source, destination, status, pattern, line: index + 1 }]
  })

const rules = parseRedirects(readFileSync(redirectsPath, "utf8"))

/** The prefixes src/index.ts answers without the assets layer: every path under them, whatever the file. */
const WORKER_ANSWERED_PREFIXES = ["/api/"]

/*
 * The retired raw gateway prefixes (src/index.ts RETIRED_GATEWAY_ROUTE_PREFIXES)
 * are answered by the Worker for an API-shaped request but asked of the assets
 * layer for a GET or HEAD navigation: the former Mintlify site published its
 * reference pages under /rpc, so a rule there is live for a navigation and
 * unreachable for a POST. The last describe proves it by driving the Worker
 * with this file as its assets layer.
 */
const RETIRED_GATEWAY_PREFIXES = ["/rpc", "/projections", "/sync", "/health"]

describe("the site's _redirects leaves the app's paths alone", () => {
  test("the file parsed into rules", () => {
    // A guard on the guard: an empty rule list would make the assertions below vacuous.
    expect(rules.length).toBeGreaterThan(100)
  })

  test("no rule matches an app path, a hashed chunk, or the build stamp", () => {
    const appPaths = [
      "/smithersai/smithers",
      "/smithersai/smithers/",
      "/w/x/b/y/f/z",
      "/_astro/a.js",
      "/__build.json",
      "/",
      "/docs/"
    ]
    const captured = appPaths.flatMap((path) =>
      rules.filter((rule) => rule.pattern.test(path)).map((rule) => `${path} <- _redirects:${rule.line} ${rule.source}`)
    )
    expect(captured).toEqual([])
  })

  test("no rule sits under a path the Worker answers itself, where it could never run", () => {
    const dead = rules.flatMap((rule) => {
      const sourcePrefix = rule.source.split("*")[0] as string
      const under = WORKER_ANSWERED_PREFIXES.filter((prefix) =>
        sourcePrefix.startsWith(prefix) || (rule.source.includes("*") && prefix.startsWith(sourcePrefix))
      )
      if (isFramePath(rule.source)) under.push("the frame path")
      return under.map((prefix) => `_redirects:${rule.line} ${rule.source} is under ${prefix}`)
    })
    expect(dead).toEqual([])
  })

  test("every splat rule redirects into the docs, never into the app or the API", () => {
    const splats = rules.filter((rule) => rule.source.includes("*"))
    expect(splats.length).toBeGreaterThan(0)
    for (const rule of splats) {
      expect(rule.destination.startsWith("/docs/")).toBe(true)
    }
  })
})

const ORIGIN = "https://smithers.sh"

/** The assets layer as _redirects shapes it: the first matching rule answers, anything else is the 404 page. */
const assetsFromRules = (asked: Array<string>): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: {
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      asked.push(`${request.method} ${path}`)
      const rule = rules.find((candidate) => candidate.pattern.test(path))
      if (rule !== undefined) return Response.redirect(new URL(rule.destination, ORIGIN).toString(), Number(rule.status))
      return new Response("<html>404 page</html>", { status: 404, headers: { "content-type": "text/html" } })
    }
  }
})

describe("a rule under a retired gateway prefix is live for a navigation and dead for an API call", () => {
  const retired = rules.filter((rule) =>
    RETIRED_GATEWAY_PREFIXES.some((prefix) => rule.source === prefix || rule.source.startsWith(`${prefix}/`))
  )

  test("the file has such rules: the former /rpc reference pages", () => {
    expect(retired.length).toBeGreaterThan(40)
    expect(retired.every((rule) => rule.source.startsWith("/rpc/"))).toBe(true)
  })

  test("every such rule answers a GET and a HEAD through the Worker exactly as the file says", async () => {
    const wrong: Array<string> = []
    for (const rule of retired) {
      for (const method of ["GET", "HEAD"]) {
        const asked: Array<string> = []
        const response = await worker.fetch(new Request(`${ORIGIN}${rule.source}`, { method }), assetsFromRules(asked))
        const got = `${response.status} -> ${response.headers.get("location")}`
        const expected = `${rule.status} -> ${new URL(rule.destination, ORIGIN)}`
        if (got !== expected) wrong.push(`${method} ${rule.source}: ${got}; _redirects:${rule.line} says ${expected}`)
      }
    }
    expect(wrong).toEqual([])
  })

  test("the same addresses stay the tombstone for a POST, never reaching the assets layer", async () => {
    const wrong: Array<string> = []
    for (const rule of retired) {
      const asked: Array<string> = []
      const response = await worker.fetch(new Request(`${ORIGIN}${rule.source}`, { method: "POST", body: "{}" }), assetsFromRules(asked))
      if (response.status !== 410 || asked.length !== 0) wrong.push(`POST ${rule.source}: ${response.status}, assets asked ${asked.length}x`)
    }
    expect(wrong).toEqual([])
  })
})
