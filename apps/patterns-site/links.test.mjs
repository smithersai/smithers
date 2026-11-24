/**
 * Every card on patterns.smithers.sh links to something that exists on main.
 *
 * The catalog is the JSON block in `site/index.html`. A `path` source is a
 * repository path the page links on GitHub: a file, a directory (written with
 * a trailing slash), or a markdown heading (`#anchor`). A `url` source is an
 * API reference page on smithers.sh, checked against the `.mdx` it is built
 * from. Every other smithers.sh path serves a fallback page with status 200,
 * so a dead link there would never show up as a 404.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { API_PAGES, readCatalog, USE_CASES } from "./catalog.mjs"

export { readCatalog }

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "../..")
const apiPages = join(root, API_PAGES)
const useCases = join(root, USE_CASES)

/**
 * The id GitHub and Starlight give a heading: inline markup dropped,
 * lowercased, punctuation other than `-` and `_` removed, spaces to hyphens,
 * and `-1`, `-2` appended to repeats.
 */
export const headingIds = (markdown) => {
  const ids = new Set()
  const seen = new Map()
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const heading = fenced ? null : line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/)
    if (!heading) continue
    const text = heading[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[`*]/g, "")
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    ids.add(count === 0 ? base : `${base}-${count}`)
  }
  return ids
}

const catalog = readCatalog(readFileSync(join(here, "site/index.html"), "utf8"))
const cards = catalog.sections.flatMap((section) => section.items.map((card) => ({ section: section.key, ...card })))
const sources = cards.flatMap((card) => card.sources.map((source) => ({ card: card.name, ...source })))

test("headingIds matches the ids GitHub and Starlight render", () => {
  const ids = headingIds("## Two halves, and why\n```\n# not a heading\n```\n### `Action.CachePolicyAnnotation`\n## Loop\n## Loop")
  assert.deepEqual([...ids], ["two-halves-and-why", "actioncachepolicyannotation", "loop", "loop-1"])
})

test("every card is named, described, and cites at least one source", () => {
  assert.ok(cards.length > 0)
  for (const card of cards) {
    assert.ok(card.name && card.description, `a card in ${card.section} has no name or description`)
    assert.ok(card.sources.length > 0, `${card.name} cites no source`)
    for (const source of card.sources) {
      assert.ok(source.label, `${card.name} has a source with no label`)
      assert.ok((source.path === undefined) !== (source.url === undefined), `${card.name}: ${source.label} needs exactly one of path or url`)
    }
  }
})

test("every path source exists on main in the form it is linked", () => {
  for (const { card, label, path } of sources.filter((source) => source.path !== undefined)) {
    const [file, anchor] = path.split("#")
    const target = join(root, file)
    assert.ok(existsSync(target), `${card}: ${label} -> ${path} does not exist`)
    assert.equal(statSync(target).isDirectory(), file.endsWith("/"), `${card}: ${path} must end with / exactly when it is a directory`)
    if (anchor !== undefined) {
      assert.match(file, /\.mdx?$/, `${card}: ${path} anchors a file GitHub renders without heading ids`)
      assert.ok(headingIds(readFileSync(target, "utf8")).has(anchor), `${card}: ${file} has no heading #${anchor}`)
    }
  }
})

test("every url source is an API reference page with that heading", () => {
  for (const { card, label, url } of sources.filter((source) => source.url !== undefined)) {
    const page = url.match(/^https:\/\/smithers\.sh\/docs\/reference\/api\/([a-z0-9-]+)\/(?:#([\w-]+))?$/)
    assert.ok(page, `${card}: ${label} -> ${url} is not an API reference page; link the repository instead`)
    const mdx = join(apiPages, `${page[1]}.mdx`)
    assert.ok(existsSync(mdx), `${card}: ${url} has no page source`)
    if (page[2] !== undefined) {
      assert.ok(headingIds(readFileSync(mdx, "utf8")).has(page[2]), `${card}: ${url} has no heading #${page[2]}`)
    }
  }
})

test("every use-case example has a card that links it", () => {
  const linked = new Set(sources.flatMap((source) => (source.path ? [source.path.split("#")[0]] : [])))
  const examples = existsSync(useCases) ? readdirSync(useCases).filter((name) => name.endsWith(".ts") && name !== "kit.ts") : []
  const missing = examples.map((name) => `packages/smithers/agent/examples/use-cases/${name}`).filter((path) => !linked.has(path))
  assert.deepEqual(missing, [])
})
