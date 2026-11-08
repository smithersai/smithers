import { ShapeSource } from "@smthrs/effect-electric"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Deferred, Effect, Layer, Logger, ManagedRuntime, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { CuratedFile } from "../../../worker/home/Curated.ts"
import { spoonKnife } from "../../../worker/test/githubRest"
import { testFile } from "../../../worker/test/harness"
import { markdown, type Page } from "../../../worker/test/pages"
import { type RepoHarness, repoHarness } from "../../../worker/test/repos"
import { DocsClient, DocsRefused } from "./api"
import { DOCS_UNREADABLE, NO_DOCS, NO_MATCHES, PAGE_UNREADABLE } from "./contract"
import { Docs } from "./docs"
import { loads } from "./records"
import { DocsStore } from "./store"
import { replaceRole, RepoStore } from "../repo/store"
import { docsPageOf } from "./view"

// The Docs tab on a tab, driven as React drives it, with no React: the routes call `warm` and `open`, the searchbox
// `search`, and the page reads the `Docs` layer's live query. The tab reaches ChatApi's real docs routes
// (worker/docs/Api.ts) over the scripted GitHub and the scripted outside web (worker/test/pages.ts); an unhappy path
// gives the tab a faulty `DocsClient` (test.faults-by-injection).

const server = testFile("docs_tab")

const waitFor = <A>(check: () => A) => vi.waitFor(check, { timeout: 10_000 })

const SECRET = "sentinel-docs-4e1a"
const INDEX = "https://docs.example/llms.txt"
const index = [
  "# Example",
  "",
  "> Example docs.",
  "",
  "- [Overview](/overview.md): Start here.",
  "",
  "## Guide",
  "",
  `- [Retrying](/guide/retrying.md): Retry a failing effect ${SECRET}.`,
  "- [Gone](/guide/gone.md): A page the site lost.",
  "",
  "## Reference",
  "",
  "- [Schedule](/reference/schedule.md): Schedules for retry and repeat.",
].join("\n")
const RETRYING = `# Retrying\n\nSee [Schedule](/reference/schedule.md). ${SECRET}\n`
const site: Record<string, Page> = {
  [INDEX]: markdown(index),
  "https://docs.example/guide/retrying.md": markdown(RETRYING),
  "https://bare.example/llms.txt": markdown("# Bare\n\n- [A](/a.md)"),
}

const curated = (repository: string, docs?: string): CuratedFile => ({
  repository,
  defaultBranch: "main",
  home: { ...(docs === undefined ? {} : { docs }), blocks: [{ type: "text", text: "Curated" }] },
})

const harness = async () => {
  const h = await repoHarness(server, { actor: null, pages: site, homes: [curated("acme/plain"), curated("acme/bare", "https://bare.example/llms.txt")] })
  h.github.publish("acme", "widgets", spoonKnife({
    fullName: "acme/widgets",
    home: { text: JSON.stringify({ docs: INDEX, blocks: [{ type: "text", text: "Hi" }] }) },
  }))
  h.github.publish("acme", "plain", spoonKnife({ fullName: "acme/plain" }))
  return h
}

const tabs: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const tab of tabs.splice(0)) await tab.dispose()
})

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** A tab's Docs layer over ChatApi at `h`, or over `client` for an unhappy path. */
const open = async (h: RepoHarness, client?: Layer.Layer<DocsClient>) => {
  const logs: Array<StructuredLog> = []
  const registry: Metric.MetricRegistry = new Map()
  const runtime = ManagedRuntime.make(
    Docs.layer.pipe(
      Layer.provideMerge(DocsStore.layer),
      Layer.provideMerge(
        client ?? DocsClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
      Layer.provideMerge(Persistence.memory),
      Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
      Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
      Layer.provideMerge(Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))])),
    ),
  )
  const docs = await runtime.runPromise(Effect.service(Docs))
  docs.queries.docs.startSyncImmediate()
  const store = await runtime.runPromise(Effect.service(DocsStore))
  const tab = {
    docs,
    store,
    logs,
    row: () => docs.queries.docs.toArray[0],
    page: () => docsPageOf(docs.queries.docs.toArray[0]),
    count: (attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(loads, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    lines: () => logs.filter((log) => log.message === "docs.tab").map((log) => log.annotations),
    dispose: () => runtime.dispose(),
  }
  tabs.push(tab)
  return tab
}

const titles = (pages: ReadonlyArray<{ readonly title: string }>) => pages.map((page) => page.title)

describe("the Docs tab", () => {
  test("opens a repository's docs: its index by section, read once, with no page chosen", async () => {
    const h = await harness()
    const tab = await open(h)
    expect(tab.page()).toEqual({ kind: "loading" })
    tab.docs.actions.open("acme", "widgets")
    await waitFor(() => expect(tab.page().kind).toBe("docs"))
    const page = tab.page()
    expect(page).toMatchObject({ kind: "docs", owner: "acme", name: "widgets", title: "Example", summary: "Example docs.", page: null, path: null, query: "" })
    expect(page.kind === "docs" && page.list).toEqual({
      kind: "index",
      groups: [
        { section: null, pages: [expect.objectContaining({ title: "Overview" })] },
        { section: "Guide", pages: [expect.objectContaining({ title: "Retrying" }), expect.objectContaining({ title: "Gone" })] },
        { section: "Reference", pages: [expect.objectContaining({ title: "Schedule" })] },
      ],
    })
    // Opened again, the index this tab has shows at once and is not read again.
    tab.docs.actions.open("ACME", "Widgets")
    expect(tab.page().kind).toBe("docs")
    expect(tab.count({ kind: "index", outcome: "ok" })).toBe(1)
    expect(tab.lines()).toEqual([
      expect.objectContaining({ feature: "docs", kind: "index", outcome: "ok", results: 4, durationMs: expect.any(Number) }),
    ])
    // An index with no summary, from a curated home's docs while GitHub is offline.
    tab.docs.actions.open("acme", "bare")
    await waitFor(() => expect(tab.page()).toMatchObject({ kind: "docs", title: "Bare", summary: null }))
  })

  test("warm reads the docs without showing them, and ends once read", async () => {
    const h = await harness()
    const tab = await open(h)
    await tab.docs.actions.warm("acme", "widgets", "/guide/retrying.md")
    expect(tab.row()?.current.repoKey).toBe("")
    expect(tab.store.indexes.tanstack.get("acme/widgets")?.state).toBe("ready")
    expect(tab.store.pages.tanstack.get("acme/widgets:/guide/retrying.md")?.state).toBe("text")
    tab.docs.actions.open("acme", "widgets", "/guide/retrying.md")
    expect(tab.page()).toMatchObject({ kind: "docs", path: "/guide/retrying.md", page: { kind: "text", title: "Retrying" } })
  })

  test("shows a page with its Markdown, and says when the docs site can't give it", async () => {
    const h = await harness()
    const tab = await open(h)
    tab.docs.actions.open("acme", "widgets", "/guide/retrying.md")
    await waitFor(() => expect(tab.page()).toMatchObject({ page: { kind: "text" } }))
    expect(tab.page()).toMatchObject({
      page: { kind: "text", title: "Retrying", url: "https://docs.example/guide/retrying.md", text: RETRYING },
    })
    tab.docs.actions.open("acme", "widgets", "/guide/gone.md")
    expect(tab.page()).toMatchObject({ page: { kind: "loading" } })
    await waitFor(() => expect(tab.page()).toMatchObject({ page: { kind: "refused", notice: PAGE_UNREADABLE } }))
    tab.docs.actions.open("acme", "widgets", "/guide/missing.md")
    await waitFor(() => expect(tab.page()).toMatchObject({ page: { kind: "refused", notice: PAGE_UNREADABLE } }))
    expect(tab.count({ kind: "page", outcome: "docs_unreachable" })).toBe(1)
    expect(tab.count({ kind: "page", outcome: "page_not_found" })).toBe(1)
    // A refused page is read again on the next open.
    tab.docs.actions.open("acme", "widgets", "/guide/missing.md")
    await waitFor(() => expect(tab.count({ kind: "page", outcome: "page_not_found" })).toBe(2))
  })

  test("searches as the person types: matches best first, none for words no page holds, the index again when empty", async () => {
    const h = await harness()
    const tab = await open(h)
    tab.docs.actions.open("acme", "widgets")
    await waitFor(() => expect(tab.page().kind).toBe("docs"))
    tab.docs.actions.search("retry")
    // On its way, the list holds nothing and says nothing.
    expect(tab.page()).toMatchObject({ query: "retry", list: { kind: "results", pages: [], notice: null } })
    await waitFor(() => expect(tab.page()).toMatchObject({ list: { notice: null, pages: { length: 2 } } }))
    const found = tab.page()
    expect(found.kind === "docs" && found.list.kind === "results" && titles(found.list.pages)).toEqual(["Retrying", "Schedule"])
    tab.docs.actions.search("quokka")
    await waitFor(() => expect(tab.page()).toMatchObject({ list: { kind: "results", notice: NO_MATCHES } }))
    // The same words typed again search nothing more.
    tab.docs.actions.search("quokka ")
    expect(tab.page()).toMatchObject({ query: "quokka ", list: { notice: NO_MATCHES } })
    tab.docs.actions.search("  ")
    expect(tab.page()).toMatchObject({ query: "  ", list: { kind: "index" } })
    // The same words again are answered from this tab.
    tab.docs.actions.search("retry ")
    expect(tab.page()).toMatchObject({ list: { kind: "results", pages: { length: 2 } } })
    expect(tab.count({ kind: "search", outcome: "ok" })).toBe(2)
    // Another page of the same docs keeps the words; another repository's docs empty them.
    tab.docs.actions.open("acme", "widgets", "/guide/retrying.md")
    expect(tab.page()).toMatchObject({ query: "retry ", list: { kind: "results" } })
    tab.docs.actions.open("acme", "plain")
    expect(tab.row()?.current).toMatchObject({ query: "", searchKey: null })
  })

  test("a search typed over another interrupts it, and only the words the box holds show", async () => {
    const h = await harness()
    const held = await Effect.runPromise(Deferred.make<void>())
    const real = DocsClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer))
    // The real client, holding the answer for "re" until the test lets it go.
    const holding = Layer.effect(
      DocsClient,
      Effect.map(Effect.service(DocsClient), (client) =>
        DocsClient.of({
          ...client,
          search: (owner, name, query) =>
            query === "re" ? Effect.andThen(Deferred.await(held), client.search(owner, name, query)) : client.search(owner, name, query),
        })),
    ).pipe(Layer.provide(real))
    const tab = await open(h, holding)
    tab.docs.actions.open("acme", "widgets")
    await waitFor(() => expect(tab.page().kind).toBe("docs"))
    tab.docs.actions.search("re")
    tab.docs.actions.search("retry")
    await waitFor(() => expect(tab.page()).toMatchObject({ list: { pages: { length: 2 } } }))
    await Effect.runPromise(Deferred.succeed(held, undefined))
    // "re" was interrupted: it left no row and no record, and "retry" still shows.
    expect(tab.store.searches.tanstack.get("acme/widgets?re")).toBeUndefined()
    expect(tab.count({ kind: "search", outcome: "ok" })).toBe(1)
    expect(tab.page()).toMatchObject({ query: "retry" })
  })

  test("says when a repository has no docs, and when ChatApi can't answer", async () => {
    const h = await harness()
    const tab = await open(h)
    tab.docs.actions.open("acme", "plain")
    await waitFor(() => expect(tab.page()).toEqual({ kind: "refused", notice: NO_DOCS }))
    expect(tab.lines()).toEqual([expect.objectContaining({ kind: "index", outcome: "no_docs", status: 404 })])

    const failing = Layer.succeed(
      DocsClient,
      DocsClient.of({ search: () => Effect.fail(new DocsRefused({})), page: () => Effect.fail(new DocsRefused({})) }),
    )
    const down = await open(h, failing)
    down.docs.actions.open("acme", "widgets", "/guide/retrying.md")
    await waitFor(() => expect(down.page()).toEqual({ kind: "refused", notice: DOCS_UNREADABLE }))
    expect(down.count({ kind: "index", outcome: "unavailable" })).toBe(1)
    await waitFor(() => expect(down.count({ kind: "page", outcome: "unavailable" })).toBe(1))
  })

  test("a search ChatApi refuses says so", async () => {
    const h = await harness()
    const real = DocsClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer))
    const refusing = Layer.effect(
      DocsClient,
      Effect.map(Effect.service(DocsClient), (client) =>
        DocsClient.of({
          ...client,
          search: (owner, name, query) =>
            query === "" ? client.search(owner, name, query) : Effect.fail(new DocsRefused({ status: 503, code: "unavailable" })),
        })),
    ).pipe(Layer.provide(real))
    const tab = await open(h, refusing)
    tab.docs.actions.open("acme", "widgets")
    await waitFor(() => expect(tab.page().kind).toBe("docs"))
    tab.docs.actions.search("retry")
    await waitFor(() => expect(tab.page()).toMatchObject({ list: { kind: "results", notice: DOCS_UNREADABLE } }))
  })

  test("no record carries a query, a path, a title or a page's text", async () => {
    const h = await harness()
    const tab = await open(h)
    tab.docs.actions.open("acme", "widgets", "/guide/retrying.md")
    await waitFor(() => expect(tab.page()).toMatchObject({ page: { kind: "text" } }))
    tab.docs.actions.search(SECRET)
    await waitFor(() => expect(tab.count({ kind: "search", outcome: "ok" })).toBe(1))
    const all = JSON.stringify(tab.logs)
    for (const secret of [SECRET, "/guide/", "Retrying", "docs.example"]) expect(all).not.toContain(secret)
  })
})

// The data gate (decision 0110, 2026-11-03): a repository's docs leave the page's query in the change that refuses it,
// before any wipe runs, and show again when the mark goes.
test("a refused repository's docs leave the page's query in the change that refuses it", async () => {
  const h = await harness()
  const runtime = ManagedRuntime.make(
    Docs.layer.pipe(
      Layer.provideMerge(DocsStore.layer),
      Layer.provideMerge(RepoStore.layer({ origin: h.origin })),
      // No repository's row syncs here: the store's shape is never answered.
      Layer.provideMerge(Layer.succeed(ShapeSource.ShapeSource, ShapeSource.ShapeSource.of({ request: () => Effect.never }))),
      Layer.provideMerge(DocsClient.layer({ origin: h.origin, within: "10 seconds" }).pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provideMerge(Persistence.memory),
      Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, h.fetch)),
    ),
  )
  tabs.push({ dispose: () => runtime.dispose() })
  const docs = await runtime.runPromise(Effect.service(Docs))
  docs.queries.docs.startSyncImmediate()
  docs.actions.open("acme", "widgets", "/guide/retrying.md")
  await waitFor(() => expect(docs.queries.docs.toArray[0]).toMatchObject({ index: { state: "ready" }, page: { state: "text" } }))
  const id = "github/acme/widgets"
  const shownAfter = (change: Effect.Effect<unknown>) => runtime.runPromise(Effect.gen(function* () {
    const store = yield* DocsStore
    yield* change
    const row = (yield* store.docs.toArray)[0] as Record<string, unknown> | undefined
    return { index: row?.index, page: row?.page, search: row?.search }
  }))
  const repos = await runtime.runPromise(Effect.service(RepoStore))
  expect(await shownAfter(replaceRole(repos, { id, role: null, own: false, refused: "forbidden" })))
    .toEqual({ index: undefined, page: undefined, search: undefined })
  const again = await shownAfter(Effect.orDie(repos.roles.delete(id)))
  expect(again).toMatchObject({ index: { state: "ready" }, page: { state: "text" } })
})
