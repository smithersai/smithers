import { describe, expect, test } from "vitest"
import { docsHref, DOCS_UNREADABLE, NO_DOCS, PAGE_UNREADABLE, pathOfSplat } from "./contract"
import { emptyCurrent, type IndexRow } from "./rows"
import { docsPageOf, groupsOf, inAppHref } from "./view"

// What the Docs tab shows from its rows: pure, so every state is one call.

const pages = [
  { title: "Overview", path: "/overview.md" },
  { title: "Retrying", path: "/guide/retrying.md", section: "Guide" },
  { title: "Schedule", path: "/reference/schedule.md", section: "Reference" },
  { title: "Timeouts", path: "/guide/timeouts.md", section: "Guide" },
]

const current = { ...emptyCurrent, owner: "acme", name: "widgets", repoKey: "acme/widgets" }
const ready: IndexRow = { key: "acme/widgets", state: "ready", title: "Example", summary: null, pages, code: null }

describe("groupsOf", () => {
  test("groups pages by section, each where its first page is, in the index's order", () => {
    expect(groupsOf(pages)).toEqual([
      { section: null, pages: [pages[0]] },
      { section: "Guide", pages: [pages[1], pages[3]] },
      { section: "Reference", pages: [pages[2]] },
    ])
    expect(groupsOf([])).toEqual([])
  })
})

describe("docsPageOf", () => {
  test("nothing until a route opened docs and their index is read", () => {
    expect(docsPageOf(undefined)).toEqual({ kind: "loading" })
    expect(docsPageOf({ current: emptyCurrent })).toEqual({ kind: "loading" })
    expect(docsPageOf({ current })).toEqual({ kind: "loading" })
    expect(docsPageOf({ current, index: { ...ready, state: "loading" } })).toEqual({ kind: "loading" })
  })

  test("a refused index: no docs, or couldn't read them", () => {
    expect(docsPageOf({ current, index: { ...ready, state: "refused", code: "no_docs" } })).toEqual({ kind: "refused", notice: NO_DOCS })
    expect(docsPageOf({ current, index: { ...ready, state: "refused", code: "docs_unreachable" } })).toEqual({
      kind: "refused",
      notice: DOCS_UNREADABLE,
    })
  })

  test("a chosen page before its row exists is on its way", () => {
    const page = docsPageOf({ current: { ...current, path: "/a.md", pageKey: "acme/widgets:/a.md" }, index: ready })
    expect(page).toMatchObject({ kind: "docs", page: { kind: "loading" }, path: "/a.md" })
  })

  test("a search ChatApi refused, or one with no row yet", () => {
    const searching = { ...current, query: "x", searchKey: "acme/widgets?x" }
    expect(docsPageOf({ current: searching, index: ready })).toMatchObject({
      list: { kind: "results", pages: [], notice: null },
    })
    expect(
      docsPageOf({ current: searching, index: ready, search: { key: "acme/widgets?x", state: "refused", pages: [], code: "unavailable" } }),
    ).toMatchObject({ list: { kind: "results", notice: DOCS_UNREADABLE } })
  })
})

describe("inAppHref", () => {
  const docs = { owner: "acme", name: "widgets", pageUrl: "https://docs.example/guide/retrying.md", pages }

  test("another page of the same index on the same site opens in the app", () => {
    expect(inAppHref("https://docs.example/reference/schedule.md#x", docs)).toBe("/acme/widgets/docs/reference/schedule.md")
  })

  test("a page the index doesn't list, another site, or no URL is the site's", () => {
    expect(inAppHref("https://docs.example/unlisted.md", docs)).toBeUndefined()
    expect(inAppHref("https://elsewhere.example/reference/schedule.md", docs)).toBeUndefined()
    expect(inAppHref("not a url", docs)).toBeUndefined()
    expect(inAppHref("https://docs.example/overview.md", { ...docs, pageUrl: "" })).toBeUndefined()
  })
})

describe("the Docs tab's routes", () => {
  test("a page's path is the splat with its leading slash; no splat is the index", () => {
    expect(pathOfSplat("error-management/018-retrying.md")).toBe("/error-management/018-retrying.md")
    expect(pathOfSplat("//guide/x.md")).toBe("/guide/x.md")
    expect(pathOfSplat("")).toBeUndefined()
    expect(pathOfSplat(undefined)).toBeUndefined()
    expect(docsHref("smithersai", "vibelang")).toBe("/smithersai/vibelang/docs")
    expect(docsHref("smithersai", "vibelang", pathOfSplat("guide/x.md"))).toBe("/smithersai/vibelang/docs/guide/x.md")
  })
})

test("a refused page offers the index as recovery", () => {
  expect(PAGE_UNREADABLE).toBe("Page unavailable · choose from the list")
  expect(docsPageOf({
    current: { ...current, path: "/absent", pageKey: "acme/widgets:/absent" },
    index: ready,
    page: { key: "acme/widgets:/absent", state: "refused", title: "", url: "", text: "", code: "not_found" },
  })).toMatchObject({ page: { kind: "refused", notice: PAGE_UNREADABLE }, list: { kind: "index" } })
})
