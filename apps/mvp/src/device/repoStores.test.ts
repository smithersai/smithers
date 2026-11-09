import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { sourceText, sourcesUnder } from "../../../../packages/repo-targets/test-utils/source-readers.mjs"
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

/** Every module under `directory`, .ts or .vibe, but its tests. */
const sources = (directory: string): ReadonlyArray<string> =>
  sourcesUnder(directory, (path) => /\.test\.[a-z]+$/.test(path)).map((path) => join(directory, path))
/** The families of the collections a module names by a variable, and the ids of the local ones it names by a string. */
const synced = (path: string) =>
  [...sourceText(path).matchAll(/ElectricCollection\.make<[^>]+>\(\{\s*id: `([a-z-]+):\$\{/g)].map((match) => match[1]!)
const local = (path: string) =>
  [...sourceText(path).matchAll(/Collection\.local<[^>]+>\(\{\s*id: "([a-z0-9-]+)"/g)].map((match) => match[1]!)
const twins = join(import.meta.dirname, "../../tests/fixtures/source-readers")

test("reads a module converted to VibeLang as it reads its TypeScript twin", () => {
  expect([synced(join(twins, "vibe/Twin.ts")), local(join(twins, "vibe/Twin.ts"))]).toEqual([["twin-notes"], ["twin-drafts"]])
  expect([synced(join(twins, "vibe/Twin.ts")), local(join(twins, "vibe/Twin.ts"))])
    .toEqual([synced(join(twins, "ts/Twin.ts")), local(join(twins, "ts/Twin.ts"))])
})

test("every collection the source names by a variable is wiped on a repository's refusal, or says why not", () => {
  const named = sources(join(import.meta.dirname, "../features")).flatMap(synced)
  expect(named.length).toBeGreaterThan(10)
  for (const family of new Set(named)) expect(known).toContain(family)
})

// Astra on 11855d97: memory collections named by a string, not a variable, escaped the check above.
test("every local collection is wiped on a repository's refusal, or says why it holds no repository's content", () => {
  const named = sources(join(import.meta.dirname, "..")).flatMap(local)
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
