import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { fixture } from "../../../worker/test/codeStorage"
import { testFile } from "../../../worker/test/harness"
import { repoHarness, resetRepos } from "../../../worker/test/repos"
import { openTab, type Tab } from "../../test/repoDevice"
import { HOME_FILE } from "../../features/home/contract"
import { homePageOf, tabsOf } from "../../features/home/view"
import { renderTabsAt } from "./tabs-render"

// The repository's Home, Code and Docs tabs (src/features/home/components/HomeTabs.tsx), rendered through a real router
// over the real home layer, its repository seeded over RepoApi's real handler and the compose Postgres and Electric. A
// page underlines one tab: Home's link, `/$owner/$repo`, leads every repository URL, and the router must not mark it
// current on a file or directory page beside Code (docs/features/home.md#tabs).

const server = testFile("repo_tabs")
beforeEach(() => resetRepos(server))

const tabs: Array<Tab> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

/** The labels of the links marked current in `html`. */
const current = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].filter(([link]) => link.includes('aria-current="page"')).map(([, label]) => label)

test("a page underlines its own tab only: Code on a file or a directory, Home on the repository's home", async () => {
  const h = await repoHarness(server)
  const home = JSON.stringify({ blocks: [{ type: "text", text: "A small HTTP server." }] })
  await h.seed("maya", "tinyhttp", fixture({ files: { "README.md": "# tinyhttp\n", [HOME_FILE]: home } }))
  const tab = await openTab({ origin: h.origin, fetch: h.fetch })
  tabs.push(tab)
  tab.home.actions.open("maya", "tinyhttp")
  await vi.waitFor(() => {
    const { current: row, home: shown, curated } = tab.home.queries.home.toArray[0]!
    expect(tabsOf(homePageOf(row, shown, curated), row)).toMatchObject({ owner: "maya", repo: "tinyhttp", ref: "main" })
  }, { timeout: 10_000 })

  expect(current(await renderTabsAt("/maya/tinyhttp/blob/main/README.md", tab.home))).toEqual(["Code"])
  expect(current(await renderTabsAt("/maya/tinyhttp/tree/main/docs", tab.home))).toEqual(["Code"])
  expect(current(await renderTabsAt("/maya/tinyhttp/tree/main", tab.home))).toEqual(["Code"])
  expect(current(await renderTabsAt("/maya/tinyhttp", tab.home))).toEqual(["Home"])
})
