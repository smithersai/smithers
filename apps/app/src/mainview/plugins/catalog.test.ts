import { expect, test } from "bun:test"
import { Effect } from "effect"
import { declaredFlowNames } from "../../conformance/Vocabulary"
import { load, PluginHost } from "./AppPlugin"
import { CATALOG, installedPlugins, manifests, pluginById, shelfOrder } from "./catalog"

/** A host that registered everything, so the catalog's own promises are what is under test. */
const everything = { hasFlow: () => true }

const loadAll = (installed: ReadonlyArray<string> = CATALOG.map((plugin) => plugin.manifest.id)) =>
  Effect.runPromise(Effect.provideService(load(installedPlugins(installed)), PluginHost, everything))

test("every flow the catalog names is a flow this app declares", async () => {
  const declared = declaredFlowNames()
  const surface = await loadAll()
  const named = new Set([...surface.rail.map((entry) => entry.flow), ...surface.flows])
  expect([...named].filter((flow) => !declared.has(flow))).toEqual([])
})

test("plugin ids are unique and every dependency is a catalog entry loaded before its dependent", () => {
  const ids = CATALOG.map((plugin) => plugin.manifest.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const [index, plugin] of CATALOG.entries()) {
    for (const required of plugin.manifest.dependsOn ?? []) {
      const at = ids.indexOf(required)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(index)
    }
  }
})

test("the shelf leads with the recommended plugins, in the rank the catalog states", () => {
  const ranked = shelfOrder().map((plugin) => plugin.manifest.id)
  expect(ranked.slice(0, 3)).toEqual(["librarian", "dispatcher", "factory"])
  expect(new Set(ranked)).toEqual(new Set(CATALOG.map((plugin) => plugin.manifest.id)))
})

test("an installed subset loads in catalog order, dependency first", async () => {
  const surface = await loadAll(["factory", "librarian"])
  expect(surface.loaded.map((plugin) => plugin.id)).toEqual(["librarian", "factory"])
})

test("a runtime without those flows still loads the plugin, with no rail entry it cannot honour", async () => {
  const surface = await Effect.runPromise(
    Effect.provideService(load(installedPlugins(["librarian"])), PluginHost, { hasFlow: () => false })
  )
  expect(surface.loaded.map((plugin) => plugin.id)).toEqual(["librarian"])
  expect(surface.rail).toEqual([])
})

test("every manifest carries the copy the gallery renders", () => {
  for (const manifest of manifests()) {
    expect(manifest.summary.length).toBeGreaterThan(0)
    expect(manifest.description.length).toBeGreaterThan(0)
    expect(manifest.gettingStarted.length).toBeGreaterThan(0)
    expect(pluginById(manifest.id)?.manifest.name).toBe(manifest.name)
  }
})
