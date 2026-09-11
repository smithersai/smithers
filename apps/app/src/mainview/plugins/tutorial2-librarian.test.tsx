import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Effect } from "effect"
import { PluginGallery } from "./PluginGallery"
import { CATALOG, installedPlugins } from "./catalog"
import { load, PluginHost } from "./AppPlugin"

test("tutorial gallery only offers Librarian without changing the global shelf", () => {
  const html = renderToStaticMarkup(<PluginGallery asked="librarian" installed={[]} onInstall={() => {}} />)
  expect(html).toContain('data-plugin="librarian"')
  expect(html).toContain('aria-label="Install the Librarian"')
  expect(html).not.toContain('data-plugin="dispatcher"')
  expect(html).not.toContain('Recommended')
  expect(CATALOG).toHaveLength(5)
})


test("installed Librarian loads Wiki and history doors", async () => {
  const surface = await Effect.runPromise(Effect.provideService(load(installedPlugins(["librarian"])), PluginHost, { hasFlow: () => true }))
  expect(surface.rail.map(entry => entry.flow)).toEqual(["wiki", "history.show"])
  expect(surface.flows).toContain("history.bootstrap")
  expect(surface.flows).toContain("wiki.create")
})
