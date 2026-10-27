#!/usr/bin/env node
/** Check built links, assets, redirects, and URLs emitted outside the site. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const origin = "https://smithers.sh"
const decode = (value) => value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", "\"")

// This site's _redirects uses literal paths and one-splat paths. Fail on new
// syntax until the checker supports it, rather than silently ignoring a rule.
// https://developers.cloudflare.com/workers/static-assets/redirects/
function readRedirects(root) {
  const path = join(root, "_redirects")
  if (!existsSync(path)) return []
  const rules = readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return []
    const [source, destination, status = "302", extra] = trimmed.split(/\s+/)
    if (
      !source.startsWith("/") || source.startsWith("//") || /[:?#]/.test(source) ||
      source.split("*").length > 2 || !destination?.startsWith("/") ||
      destination.startsWith("//") || !["301", "302", "303", "307", "308"].includes(status) || extra ||
      /:[A-Za-z]/.test(destination.replaceAll(":splat", "")) ||
      (destination.includes(":splat") && !source.includes("*"))
    ) {
      throw new Error(`_redirects:${index + 1}: unsupported redirect: ${trimmed}`)
    }
    const pattern = new RegExp(
      "^" + source.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*)") + "$"
    )
    return [{ source, destination, pattern, line: index + 1 }]
  })
  // Cloudflare counts every rule from the first dynamic (splat) rule onward as
  // dynamic and refuses publish past 100 dynamic or 2,000 static rules
  // (error 100324, 2026-10-03). Keep splat rules at the end of the file.
  const firstDynamic = rules.findIndex((rule) => rule.source.includes("*"))
  const dynamic = firstDynamic === -1 ? 0 : rules.length - firstDynamic
  if (dynamic > 100) {
    throw new Error(
      `_redirects:${
        rules[firstDynamic].line
      }: ${dynamic} rules from the first splat rule onward count as dynamic (Cloudflare limit 100); move splat rules to the end`
    )
  }
  if (rules.length - dynamic > 2000) {
    throw new Error(`_redirects: ${rules.length - dynamic} static rules exceed Cloudflare's 2,000 limit`)
  }
  return rules
}

/*
 * The static-asset headers file, as Cloudflare reads it: a path rule line
 * followed by indented `Name: value` lines. Only the /_astro/* block is
 * checked; the site adds no other rule.
 * https://developers.cloudflare.com/workers/static-assets/headers/
 */
function readHeaders(root) {
  const path = join(root, "_headers")
  if (!existsSync(path)) return new Map()
  const rules = new Map()
  let current
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (!/^\s/.test(line)) {
      current = new Map()
      rules.set(trimmed, current)
      continue
    }
    const separator = trimmed.indexOf(":")
    if (current === undefined || separator === -1) {
      throw new Error(`_headers:${index + 1}: unsupported header line: ${trimmed}`)
    }
    current.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim())
  }
  return rules
}

/**
 * The headers every /_astro chunk must carry: each file name carries a
 * content hash, so a browser may keep it for a year.
 */
export const ASSET_HEADERS = Object.freeze({
  "cache-control": "public, max-age=31536000, immutable"
})

export function checkAssetHeaders(root) {
  const rules = readHeaders(root)
  const astro = rules.get("/_astro/*")
  if (astro === undefined) return ["_headers: missing the /_astro/* rule"]
  const failures = []
  for (const [name, value] of Object.entries(ASSET_HEADERS)) {
    const got = astro.get(name)
    if (got !== value) failures.push(`_headers: /_astro/* must set ${name}: ${value} (got ${got ?? "nothing"})`)
  }
  return failures
}

/** The static landing carries the install command and its Docs and Source buttons. */
export function checkLandingActions(root) {
  const landing = join(root, "index.html")
  if (!existsSync(landing)) return ["index.html: missing from the build"]
  const html = readFileSync(landing, "utf8")
  if (!/<button\b[^>]*id="copy-install"/.test(html)) return ["index.html: missing the install command's Copy button"]
  const failures = []
  for (const href of ["/docs/installation/", "https://github.com/smithersai/smithers"]) {
    if (!new RegExp(`<a class="landing-button[^"]*" href="${href.replace(/[?.]/g, "\\$&")}"`).test(html)) {
      failures.push(`index.html: missing the ${href} button`)
    }
  }
  if (!/<span id="run-command">npx smthrs@next [^<]+<\/span>/.test(html)) {
    failures.push("index.html: missing the npx run command")
  }
  return failures
}

export async function releaseReferences(repoRoot) {
  const { migrationUrl, removedVerbs, removedFlags } = await import(
    pathToFileURL(join(repoRoot, "packages/smithers/src/Unsupported.ts"))
  )
  const { legacyArguments } = await import(
    pathToFileURL(join(repoRoot, "packages/smithers/src/cli/Compatibility.ts"))
  )
  // gen-cli-data emits one anchor per removal plus the literal anchors other
  // CLI modules write by hand, so the generated table is wider than this file.
  const removed = JSON.parse(readFileSync(join(repoRoot, "apps/site/src/data/removed-commands.json"), "utf8"))
  if (
    removed.migrationUrl !== migrationUrl || !Array.isArray(removed.anchors) || removed.anchors.length === 0 ||
    removed.anchors.some((anchor) => typeof anchor !== "string" || anchor.length === 0)
  ) {
    throw new Error("Regenerate the CLI removal URL table before building the site")
  }
  const anchors = new Set(removed.anchors)
  // Check new runtime entries even before the generated table is refreshed.
  // The public bin enters Unsupported.refusal only through legacyArguments.
  for (const verb of removedVerbs) {
    if (legacyArguments([verb.name]) !== undefined) anchors.add(verb.name)
  }
  for (const flag of removedFlags) anchors.add(flag.anchor)
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8")
  const changelogUrls = new Set(
    [...changelog.matchAll(
      /https:\/\/smithers\.sh\/changelogs\/\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:#[0-9A-Za-z_-]+)?/g
    )].map((match) => match[0])
  )
  if (!changelogUrls.size) throw new Error("Cannot find the changelog's site URL")
  return [
    migrationUrl,
    migrationUrl + "/",
    ...[...anchors].map((anchor) => `${migrationUrl}#${anchor}`),
    ...changelogUrls
  ]
}

/**
 * Every same-site reference a built page, a docs Markdown copy, a required
 * release URL or a literal `_redirects` source names must land on a file of
 * this build, through at most the redirects `_redirects` declares, with its
 * fragment present on the page.
 */
export function checkBuiltSite(root, requiredReferences = []) {
  const pages = new Map()
  const failures = new Set()
  const redirects = readRedirects(root)
  // The docs pages' Markdown copies (scripts/sync-app-docs.mjs) link pages and
  // screenshots by absolute smithers.sh URL; each must land in this build.
  const markdown = new Map()
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".md")) {
        markdown.set(
          path,
          [...readFileSync(path, "utf8").matchAll(/\]\((https:\/\/smithers\.sh\/[^)\s]*)\)/g)].map((match) => match[1])
        )
      } else if (entry.name.endsWith(".html")) {
        const html = readFileSync(path, "utf8")
        pages.set(path, {
          ids: new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((match) => decode(match[1]))),
          references: [
            ...[...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((match) => decode(match[1])),
            // Social crawlers fetch these images; a missing file renders a blank card.
            ...[...html.matchAll(/<meta\s+(?:property|name)="(?:og|twitter):image"\s+content="([^"]*)"/g)]
              .map((match) => decode(match[1]))
          ]
        })
      }
    }
  }
  if (!existsSync(root)) throw new Error("Build the site before checking its links")
  walk(root)
  // The URL a reference resolves to, or undefined when this origin does not
  // serve it: an external link, a mailto:/data: reference, or an unparseable
  // value. `base` is the page that emitted the reference, so a
  // document-relative or fragment-only href resolves the way a browser
  // reading that page resolves it.
  function siteUrl(reference, base) {
    let url
    try {
      url = new URL(reference, base)
    } catch {
      return undefined
    }
    return url.origin === origin ? url : undefined
  }
  function check(reference, source, base = origin) {
    let url = siteUrl(reference, base)
    if (url === undefined) {
      failures.add(`${source}: required URL leaves the site: ${reference}`)
      return
    }
    const visited = new Set()
    while (true) {
      if (visited.has(url.pathname) || visited.size >= 32) {
        failures.add(`${source}: redirect cycle or excessive chain at ${url.pathname}: ${reference}`)
        return
      }
      visited.add(url.pathname)
      const rule = redirects.find((rule) => rule.pattern.test(url.pathname))
      if (!rule) break
      const match = rule.pattern.exec(url.pathname)
      const destination = new URL(rule.destination.replaceAll(":splat", () => match[1] ?? ""), origin)
      // HTTP redirects without an explicit fragment inherit the original one.
      if (!rule.destination.includes("#")) destination.hash = url.hash
      url = destination
    }
    // These exact app-owned routes share the origin and are not docs assets.
    // Regression tests pin them to app declarations and reject unknown paths.
    if (["/app/bugs/report", "/app/flows", "/app/settings"].includes(url.pathname) && !url.hash) return
    let target = join(root, decodeURIComponent(url.pathname))
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html")
    if (!existsSync(target)) failures.add(`${source}: missing ${reference} (resolved to ${url.pathname})`)
    else if (
      url.hash && !(visited.size > 1 && url.pathname === "/docs/installation/") && pages.has(target) &&
      !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))
    ) {
      failures.add(`${source}: missing anchor ${reference} (resolved to ${url.pathname}${url.hash})`)
    }
  }
  for (const [page, { references }] of pages) {
    // A page's own URL: the base a browser resolves its references against.
    // Every internal form reaches the same check that way, whether the page
    // writes a full site URL (the social card), a root-relative path, a
    // document-relative path, or a bare fragment naming its own headings.
    const base = new URL(
      relative(root, page).split(sep).map((segment) => encodeURIComponent(segment)).join("/"),
      origin + "/"
    )
    for (const reference of references) {
      if (/^https:\/\/github\.com\/apps\/smithers(?:[/?#]|$)/.test(reference)) {
        failures.add(`${relative(root, page)}: retired GitHub App URL: ${reference}`)
      }
      if (siteUrl(reference, base) === undefined) continue
      check(reference, relative(root, page), base)
    }
  }
  for (const [file, references] of markdown) {
    for (const reference of references) check(reference, relative(root, file))
  }
  for (const reference of requiredReferences) check(reference, "release URL")
  for (const rule of redirects) {
    if (!rule.source.includes("*")) check(rule.source, "_redirects")
  }
  return { pageCount: pages.size, requiredReferenceCount: requiredReferences.length, failures: [...failures] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(siteRoot, "dist")
  // Keep links indexed by the former Mintlify site working after the cutover.
  // The captured sitemap is independent of _redirects, so deleting an alias
  // cannot silently remove the URL from this check as well.
  const legacy = JSON.parse(readFileSync(join(siteRoot, "src/data/mintlify-paths.json"), "utf8"))
  const result = checkBuiltSite(
    root,
    [
      ...await releaseReferences(resolve(siteRoot, "../..")),
      ...legacy.paths.flatMap((path) => path === "/" ? [path] : [path, path + "/"])
    ]
  )
  // The files a static host needs beyond the pages: the 404 page it serves for
  // an unknown path, the icons and robots.txt.
  for (const file of ["404.html", "favicon.png", "apple-touch-icon.png", "robots.txt"]) {
    if (!existsSync(join(root, file))) result.failures.push(`${file}: missing from the build`)
  }
  result.failures.push(...checkAssetHeaders(root))
  result.failures.push(...checkLandingActions(root))
  for (const name of ["llms.txt", "llms-full.txt"]) {
    if (
      !existsSync(join(root, name)) ||
      !readFileSync(join(siteRoot, "public", name)).equals(readFileSync(join(root, name)))
    ) {
      result.failures.push(`${name}: built content differs from the current generated source`)
    }
  }
  for (const failure of result.failures) console.error(failure)
  console.log(
    `check-built-site: ${result.pageCount} pages, ${result.requiredReferenceCount} required URLs, ${result.failures.length} failures`
  )
  if (result.failures.length) process.exitCode = 1
}
