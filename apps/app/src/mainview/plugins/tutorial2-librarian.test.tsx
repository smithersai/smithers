import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Effect } from "effect"
import { PluginGallery } from "./PluginGallery"
import { CATALOG, installedPlugins } from "./catalog"
import { load, PluginHost } from "./AppPlugin"
import { initialGuide } from "../state/AppState"
import { libraryOpened, pluginInstalled, LIBRARIAN_LESSON_STEP } from "../onboarding/pluginLesson"

test("tutorial gallery only offers Librarian without changing the global shelf", () => {
  const html = renderToStaticMarkup(<PluginGallery asked="librarian" installed={[]} onInstall={() => {}} />)
  expect(html).toContain('data-plugin="librarian"')
  expect(html).toContain('aria-label="Install the Librarian"')
  expect(html).not.toContain('data-plugin="dispatcher"')
  expect(html).not.toContain('Recommended')
  expect(CATALOG).toHaveLength(5)
})

test("Library browse never signals librarian; other installs and stale stages do not complete", () => {
  const guide = { ...initialGuide(), step: LIBRARIAN_LESSON_STEP }
  expect(libraryOpened(guide)?.completed).not.toContain("librarian")
  expect(pluginInstalled(guide, "dispatcher")).toBeUndefined()
  expect(pluginInstalled({ ...guide, step: 4 }, "librarian")).toBeUndefined()
  const completed = pluginInstalled(guide, "librarian")!
  expect(completed.completed).toContain("librarian")
  expect(pluginInstalled(completed, "librarian")).toBeUndefined()
  expect(pluginInstalled({ ...guide, playthrough: (guide.playthrough ?? 0) + 1 }, "librarian")?.completed).toContain("librarian")
})

test("installed Librarian loads Wiki and history doors", async () => {
  const surface = await Effect.runPromise(Effect.provideService(load(installedPlugins(["librarian"])), PluginHost, { hasFlow: () => true }))
  expect(surface.rail.map(entry => entry.flow)).toEqual(["wiki", "history.show"])
  expect(surface.flows).toContain("history.bootstrap")
  expect(surface.flows).toContain("wiki.create")
})
