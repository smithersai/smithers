/**
 * M-49: site-owned copy names a repository's flows at `.smithers/flows/`, never
 * at a root `flows/`. Generated pages follow their package sources, and
 * `generate-llms.mjs --check` holds public/llms*.txt to those sources.
 * The hero also shows the approved-policy argument and setup for trusted review.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path) => readFileSync(join(site, path), "utf8")
// A root `flows/` path in prose: `flows/<name>/...` or `flows/` in backticks.
const retired = /(?<![.\w/@-])flows\/(?=[<`])/

test("migration paths name .smithers/flows/ for a repository's flows", () => {
  const paths = Object.values(JSON.parse(read("src/data/migration-paths.json")).paths)
  assert.deepEqual(paths.filter((text) => retired.test(text)), [])
  assert.ok(paths.some((text) => text.includes("`.smithers/flows/<name>/flow.mdx`")))
})

test("the hero tree keeps a repository's flows under .smithers/", () => {
  const hero = read("src/components/HeroStage.astro")
  assert.doesNotMatch(hero, /depth: 0, name: "flows\/"/)
  assert.match(hero, /depth: 0, name: "\.smithers\/"[^\n]*\n(?:[^\n]*depth: [1-9][^\n]*\n)*[^\n]*depth: 1, name: "flows\/"/)
})

test("the hero review command selects approved policy and links its setup", () => {
  const hero = read("src/components/HeroStage.astro")
  const terminal = hero.match(/<div class="run"[^>]*>([\s\S]*?)<\/div>/)?.[1]
  assert.ok(terminal, "the example includes a review command")
  const command = terminal.replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replace(/\s+/g, " ")
  assert.match(command, /smithers-build review \/\/packages\/smithers\/flows\/engine-store --policy-revision <approved-commit-sha>/)
  const setup = hero.match(/href="https:\/\/github\.com\/smithersai\/smithers\/blob\/main\/([^"#]+)#run-a-review"/)?.[1]
  assert.ok(setup, "the example links to review setup")
  const guide = readFileSync(new URL(`../../../${setup}`, import.meta.url), "utf8")
  assert.match(guide, /^## Run a review$/m)
  assert.match(hero, /<code>pnpm target-index<\/code>/)
})
