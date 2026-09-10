/**
 * Covers the one implementation of the public repository stats: the catalog
 * fetch, the count validation, the status fallback, and what it writes into a
 * card's slots.
 *
 * The helper takes its cards from the caller. The final test keeps the
 * catalog contract in that one file.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { fillRepoStats } from "../src/components/repoStats.ts"

const componentsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components")

/** The slots of one card, keyed by the selector the helper asks for. */
const card = (name) => {
  const slot = (textContent = "—") => ({
    textContent,
    title: "",
    attributes: {},
    setAttribute(attribute, value) {
      this.attributes[attribute] = value
    }
  })
  const slots = {
    "[data-stats]": slot(""),
    '[data-stat="stars"]': slot(),
    '[data-stat="forks"]': slot(),
    '[data-stat="openIssuesAndPulls"]': slot(),
    "[data-meta]": slot(""),
    "[data-stats-status]": slot("Loading stats…")
  }
  return { dataset: { repo: name }, querySelector: (selector) => slots[selector] ?? null, slots }
}

/** Answers every request with `body`, recording the requests it received. */
const catalog = (body, init) => {
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      ...init
    })
  }
  return requests
}

const stats = (card) => ({
  stars: card.slots['[data-stat="stars"]'].textContent,
  forks: card.slots['[data-stat="forks"]'].textContent,
  openIssuesAndPulls: card.slots['[data-stat="openIssuesAndPulls"]'].textContent,
  meta: card.slots["[data-meta]"].textContent,
  status: card.slots["[data-stats-status]"].textContent,
  busy: card.slots["[data-stats]"].attributes["aria-busy"]
})

test("fills every card the caller passes from the catalog", async () => {
  const available = card("evmts/smithers")
  const soon = card("evanw/esbuild")
  const requests = catalog({
    repos: [{ name: "evmts/smithers", stats: { stars: 1234, forks: 56, openIssuesAndPulls: 7, language: "TypeScript", license: "MIT" } }],
    comingSoon: [{ name: "evanw/esbuild", stats: { stars: 39500, forks: 1200, openIssuesAndPulls: 50, language: "Go", license: "MIT" } }]
  })

  await fillRepoStats("https://smithers.sh/api/public-repos", [available, soon])

  assert.deepEqual(requests.map((request) => request.url), ["https://smithers.sh/api/public-repos"])
  assert.equal(requests[0].options.credentials, "omit")
  assert.deepEqual(stats(available), {
    stars: "1.2K",
    forks: "56",
    openIssuesAndPulls: "7",
    meta: "TypeScript · MIT",
    status: "",
    busy: "false"
  })
  assert.equal(available.slots['[data-stat="stars"]'].title, "1,234")
  assert.deepEqual(stats(soon), {
    stars: "39.5K",
    forks: "1.2K",
    openIssuesAndPulls: "50",
    meta: "Go · MIT",
    status: "",
    busy: "false"
  })
})

test("reports stats unavailable for a repository the catalog omits", async () => {
  const missing = card("evanw/esbuild")
  catalog({ repos: [{ name: "evmts/smithers", stats: { stars: 1, forks: 1, openIssuesAndPulls: 1 } }] })

  await fillRepoStats("https://smithers.sh/api/public-repos", [missing])

  assert.deepEqual(stats(missing), { stars: "—", forks: "—", openIssuesAndPulls: "—", meta: "", status: "Stats unavailable", busy: "false" })
})

test("refuses counts that are not safe non-negative integers", async () => {
  const cards = [card("a/one"), card("a/two"), card("a/three"), card("a/four")]
  catalog({
    repos: [
      { name: "a/one", stats: { stars: -1, forks: 2, openIssuesAndPulls: 3 } },
      { name: "a/two", stats: { stars: 1.5, forks: 2, openIssuesAndPulls: 3 } },
      { name: "a/three", stats: { stars: "12", forks: 2, openIssuesAndPulls: 3 } },
      { name: "a/four", stats: { stars: 1, forks: 2 } }
    ]
  })

  await fillRepoStats("https://smithers.sh/api/public-repos", cards)

  for (const rejected of cards) assert.deepEqual(stats(rejected), { stars: "—", forks: "—", openIssuesAndPulls: "—", meta: "", status: "Stats unavailable", busy: "false" })
})

test("falls back on a failed response, unparsable body, or missing repos array", async () => {
  const failures = [
    () => catalog({ repos: [] }, { status: 500 }),
    () => catalog("not json"),
    () => catalog({ comingSoon: [] }),
    () => {
      globalThis.fetch = async () => {
        throw new TypeError("network error")
      }
    }
  ]
  for (const failure of failures) {
    const only = card("evmts/smithers")
    failure()
    await fillRepoStats("https://smithers.sh/api/public-repos", [only])
    assert.deepEqual(stats(only), { stars: "—", forks: "—", openIssuesAndPulls: "—", meta: "", status: "Stats unavailable", busy: "false" })
  }
})

test("keeps the catalog contract in repoStats.ts alone", () => {
  for (const component of ["AvailableRepos.astro"]) {
    const source = readFileSync(join(componentsDir, component), "utf8")
    assert.match(source, /import \{ fillRepoStats \} from "\.\/repoStats"/, `${component} renders stats without the shared helper`)
    assert.ok(!source.includes("fetch("), `${component} fetches the catalog itself`)
  }
})
