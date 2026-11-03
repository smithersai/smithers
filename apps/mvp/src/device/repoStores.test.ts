import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { openTestApp } from "../test/chatApi"
import { RepoStore } from "../features/repo/store"
import { REPOSITORY_MEMORY, REPOSITORY_STORES, UNSCOPED_LOCAL, UNWIPED_FAMILIES } from "./repoStores"
import { deviceRegistry } from "./registry"

const known = [...REPOSITORY_STORES, ...REPOSITORY_MEMORY, ...Object.keys(UNWIPED_FAMILIES)]

// Will's wipe rule: a refusal on a repository wipes every store of its rows. A new per-repository store fails here until
// it registers, or says why not.
test("every collection family the device keeps is wiped on a repository's refusal, or says why not", () => {
  const families = deviceRegistry.stores.flatMap((store) => store._tag === "Synced" && store.family ? [store.id] : [])
  for (const family of families) expect(known).toContain(family)
})

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sources(path) : /(?<!\.test)\.tsx?$/.test(entry) ? [path] : []
  })

test("every collection the source names by a variable is wiped on a repository's refusal, or says why not", () => {
  const named = sources(join(import.meta.dirname, "../features")).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/ElectricCollection\.make<[^>]+>\(\{\s*id: `([a-z-]+):\$\{/g)].map((match) => match[1]!))
  expect(named.length).toBeGreaterThan(10)
  for (const family of new Set(named)) expect(known).toContain(family)
})

// Astra on 11855d97: memory collections named by a string, not a variable, escaped the check above.
test("every local collection is wiped on a repository's refusal, or says why it holds no repository's content", () => {
  const named = sources(join(import.meta.dirname, "..")).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/Collection\.local<[^>]+>\(\{\s*id: "([a-z0-9-]+)"/g)].map((match) => match[1]!))
  expect(named.length).toBeGreaterThan(50)
  const classified = [...REPOSITORY_MEMORY, ...Object.keys(UNSCOPED_LOCAL)]
  for (const id of new Set(named)) expect(classified).toContain(id)
})

test("the app registers every repository cache with the one owner of a refusal", async () => {
  const runtime = openTestApp()
  try {
    const repos = await runtime.runPromise(Effect.service(RepoStore))
    expect([...repos.registeredCaches()].sort()).toEqual([...REPOSITORY_STORES, ...REPOSITORY_MEMORY].sort())
  } finally { await runtime.dispose() }
}, 90_000)
