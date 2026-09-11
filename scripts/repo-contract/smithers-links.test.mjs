/**
 * Every smithers.sh URL shipped in package source or a package README resolves
 * against the static site or one of its production redirects.
 *
 * The target builds the site before running this gate. It stays offline:
 * emitted HTML is the route oracle, and `public/_redirects` supplies the
 * compatibility routes.
 * Redirects are resolved once, then their destination must be an emitted route.
 * A redirect chain therefore fails the gate; rejecting chains keeps the test
 * deterministic and makes every compatibility destination independently real.
 * Test fixture URL literals are excluded because TypeScript scanning is limited
 * to comments; parser and renderer inputs are not shipped documentation links.
 *
 * Run it with `pnpm exec smithers-build test '//scripts/repo-contract:smithersLinks'`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"
import { describe, it } from "node:test"

import { repoRoot as root } from "../workspace-packages.mjs"

const packages = join(root, "packages")
const site = join(root, "apps", "site")
const output = join(site, "dist")
const urlPattern = /https?:\/\/smithers\.sh[^\s<>"'`)\]}]*/g
const ignoredDirectories = new Set(["dist", "node_modules", "test"])

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : walk(path)
    return [path]
  })

const shippingFiles = () =>
  walk(packages).filter((path) => {
    const extension = extname(path)
    if (extension === ".ts" || extension === ".tsx") return true
    if (path.endsWith(`${sep}docs${sep}README.md`)) return false
    if (path.endsWith(`${sep}README.md`)) return existsSync(join(path, "..", "package.json"))
    return false
  })

const routes = () => {
  assert.ok(existsSync(output), "apps/site/dist is missing; run `pnpm -C apps/site build` first")
  return new Set(
    walk(output).flatMap((path) => {
      if (!path.endsWith(".html")) return []
      const emitted = `/${relative(output, path).split(sep).join("/")}`
      if (emitted === "/index.html") return ["/"]
      if (emitted.endsWith("/index.html")) return [emitted.slice(0, -"index.html".length)]
      return [emitted.slice(0, -".html".length), emitted]
    })
  )
}

const redirects = () =>
  readFileSync(join(site, "public", "_redirects"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [source, destination] = line.split(/\s+/)
      const splat = source.endsWith("/*")
      return { source: splat ? source.slice(0, -1) : source, destination, splat }
    })

const redirectedPath = (pathname, rule) => {
  if (rule.splat && pathname.startsWith(rule.source)) {
    // `pathname` is normalized with a trailing slash, so the captured splat
    // carries one too. Leaving it produces `/docs/reference/errors//`, which
    // matches no emitted route and would fail every splat-resolved URL.
    return rule.destination.replace(":splat", pathname.slice(rule.source.length).replace(/\/$/, ""))
  }
  return !rule.splat && pathname === normalize(rule.source) ? rule.destination : undefined
}

const normalize = (pathname) => pathname === "/" || pathname.endsWith("/") ? pathname : `${pathname}/`

describe("smithers.sh links in shipping packages", () => {
  it("renders archived changelog media with their captions", () => {
    const html = readFileSync(join(output, "changelogs", "0230", "index.html"), "utf8")
    assert.match(
      html,
      /<figure[^>]*>[\s\S]*?<img[^>]*src="\/images\/why\/crash-resume.gif"[\s\S]*?<figcaption[^>]*>Durability is the whole point:/
    )
  })

  it("resolve against the built site or one direct production redirect", () => {
    const builtRoutes = routes()
    const rules = redirects()
    const offenders = []
    for (const file of shippingFiles()) {
      let inBlockComment = false
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const source = file.endsWith(".ts") || file.endsWith(".tsx")
        const blockStarts = line.indexOf("/*")
        const lineComment = line.indexOf("//")
        const commentStarts = inBlockComment
          ? 0
          : [blockStarts, lineComment].filter((position) => position >= 0).sort((a, b) => a - b)[0]
        const searchable = source && commentStarts === undefined ? "" : line.slice(commentStarts ?? 0)
        if (blockStarts >= 0 && line.indexOf("*/", blockStarts + 2) < 0) inBlockComment = true
        if (inBlockComment && line.includes("*/")) inBlockComment = false
        for (const raw of searchable.match(urlPattern) ?? []) {
          const url = new URL(raw.replace(/[.,;:]$/, ""))
          const pathname = normalize(url.pathname)
          if (builtRoutes.has(pathname)) continue
          const destination = rules.map((rule) => redirectedPath(pathname, rule)).find(Boolean)
          if (destination !== undefined && builtRoutes.has(normalize(destination))) continue
          offenders.push(`${relative(root, file)}:${index + 1} ${url.href}`)
        }
      }
    }
    assert.deepEqual(offenders, [], `smithers.sh URLs with no built route or redirect:\n  ${offenders.join("\n  ")}`)
  })
})
