import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isFramePath } from "./appDocument"

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
