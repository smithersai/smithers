/**
 * Patterns catalog site (`patterns.smithers.sh`).
 *
 * The page is one static file, `site/index.html`, served by the `patterns-site`
 * Worker (`wrangler.jsonc`). Its cards link into the whole repository, so the
 * link check declares every linked file from the catalog, the site package's
 * API reference filegroup, and every current use-case example file, and runs
 * uncached so newly added use-case examples are never masked by a stale cache.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { Smithers } from "@smthrs/targets"
import { Package as sitePackage } from "../site/PACKAGE.ts"
import { linkedPaths, readCatalog, USE_CASES } from "./catalog.mjs"

const repoRoot = new URL("../../", import.meta.url)
const catalog = readCatalog(readFileSync(new URL("site/index.html", import.meta.url), "utf8"))

const listFiles = (relDir: string): Array<string> => {
  const dir = relDir.replace(/\/+$/, "")
  const abs = new URL(`${dir}/`, repoRoot)
  if (!existsSync(abs)) return []
  const found: Array<string> = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const child = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...listFiles(child))
    else if (entry.isFile()) found.push(child)
  }
  return found.sort()
}

const fileInputs = new Set<string>()
for (const path of linkedPaths(catalog)) {
  if (path.endsWith("/")) {
    for (const child of listFiles(path)) fileInputs.add(child)
  } else if (existsSync(new URL(path, repoRoot))) {
    fileInputs.add(path)
  }
}
for (const child of listFiles(USE_CASES)) fileInputs.add(child)

const linked = [...fileInputs].sort().map((path) => Smithers.file(`//${path}`))

/**
 * Every card's source resolves to a file, directory, or heading on main, and
 * every use-case example under `packages/smithers/agent/examples/use-cases/`
 * has a card.
 *
 * @since 1.0.0
 * @category test
 */
const links = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//apps/patterns-site/links.test.mjs")]),
  cache: false,
  srcs: [
    Smithers.glob("//apps/patterns-site/site/**"),
    Smithers.file("//apps/patterns-site/catalog.mjs"),
    ...linked
  ],
  deps: [sitePackage.apiReferenceSources]
})

export const Package = Smithers.Package({ targets: { links } })
