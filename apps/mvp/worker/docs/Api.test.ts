// A repository's docs routes (worker/docs/Api.vibe, docs/features/docs.md#chatapi) through ChatApi's real handlers, as
// worker/ChatApi.ts routes them: what GitHub says of the repository (its own home) from the scripted GitHub, Smithers'
// curated homes, and the docs site from the scripted outside web (worker/test/pages.ts), through `@smthrs/views`' real
// `Docs.fetchText` and Effect's real fetch client.
import { describe, expect, test, vi } from "vitest"
import { docsPageRoute, docsRoute, MAX_LISTED, MAX_PAGE_BYTES, SEARCH_LIMIT } from "../../src/features/docs/contract.ts"
import { spoonKnife } from "../test/githubRest.ts"
import { recorded, testFile } from "../test/harness.ts"
import { markdown, type Page } from "../test/pages.ts"
import { repoHarness } from "../test/repos.ts"
import type { CuratedFile } from "../home/Curated.ts"
import * as DocsApi from "./Api.vibe"

const runtime = testFile("docs_api")

const INDEX = "https://docs.example/llms.txt"
const SENTINEL = "zebra-sentinel"

const index = [
  "# Example",
  "",
  "> Example docs for tests.",
  "",
  "## Guide",
  "",
  "- [Getting started](https://docs.example/guide/start.md): Install and run.",
  `- [Retrying](/guide/retrying.md): Retry a failing effect with a ${SENTINEL}.`,
  "- [Elsewhere](https://evil.example/steal.md): Off the index's origin.",
  "",
  "## Reference",
  "",
  "- [Schedule](https://docs.example/reference/schedule.md): Schedules for retry and repeat.",
].join("\n")

const RETRYING = `# Retrying\n\nUse \`retry\` with a ${SENTINEL}.\n`

const site: Record<string, Page> = {
  [INDEX]: markdown(index),
  "https://docs.example/guide/retrying.md": markdown(RETRYING),
  "https://docs.example/guide/start.md": markdown("# Getting started\n"),
}

/** A repository whose own home names `docs`, or names none. */
const homed = (fullName: string, docs?: string) =>
  spoonKnife({
    fullName,
    home: { text: JSON.stringify({ ...(docs === undefined ? {} : { docs }), blocks: [{ type: "text", text: "Hi" }] }) },
  })

const curated = (repository: string, docs: string): CuratedFile => ({
  repository,
  defaultBranch: "main",
  home: { docs, blocks: [{ type: "text", text: "Curated" }] },
})

const open = async (options: Parameters<typeof repoHarness>[1] = {}) => {
  const h = await repoHarness(runtime, { actor: null, pages: site, ...options })
  h.github.publish("acme", "widgets", homed("acme/widgets", INDEX))
  return h
}

describe("GET /api/repos/<owner>/<name>/docs", () => {
  test("a signed-out visitor reads the index the repository's own home names: every page in order, kept for a while", async () => {
    const h = await open()
    const response = await h.fetch(docsRoute("acme", "widgets"))
    expect([response.status, response.headers.get("cache-control")]).toEqual([200, "public, max-age=60"])
    expect(await response.json()).toEqual({
      title: "Example",
      summary: "Example docs for tests.",
      pages: [
        { title: "Getting started", path: "/guide/start.md", description: "Install and run.", section: "Guide" },
        {
          title: "Retrying",
          path: "/guide/retrying.md",
          description: `Retry a failing effect with a ${SENTINEL}.`,
          section: "Guide",
        },
        {
          title: "Schedule",
          path: "/reference/schedule.md",
          description: "Schedules for retry and repeat.",
          section: "Reference",
        },
      ],
    })
    // The second read is the cache's: the docs site is asked once, and so is GitHub.
    expect((await h.fetch(docsRoute("ACME", "Widgets"))).status).toBe(200)
    expect(h.asked).toEqual([INDEX])
    expect(h.github.calls.filter((call) => call === "")).toHaveLength(1)
    expect(h.line("repo.docs").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ outcome: "ok", status: 200, results: 3, source: "declared", cached: false, searched: false }),
      expect.objectContaining({ outcome: "ok", status: 200, results: 3, cached: true }),
    ])
    expect(h.count(DocsApi.requests, { route: "index", status: "200" })).toBe(2)
    expect(h.span("repo.docs")).toHaveLength(2)
  })

  test("searches the index: the best matches first, at most eight, and none for words no page holds", async () => {
    const h = await open()
    const found = await (await h.fetch(docsRoute("acme", "widgets", "retry"))).json() as { pages: Array<{ title: string }> }
    expect(found.pages.map((page) => page.title)).toEqual(["Retrying", "Schedule"])
    expect(await (await h.fetch(docsRoute("acme", "widgets", "  "))).json()).toMatchObject({ pages: { length: 3 } })
    expect(await (await h.fetch(docsRoute("acme", "widgets", "quokka"))).json()).toMatchObject({ pages: [] })
    expect(h.line("repo.docs").map((line) => line.annotations.results)).toEqual([2, 3, 0])

    // The first page has no description: it is answered without one.
    const many = Array.from({ length: MAX_LISTED + 20 }, (_, n) => `- [Retry ${n}](/p/${n}.md)${n === 0 ? "" : ": retry"}`)
      .join("\n")
    h.github.publish("acme", "many", homed("acme/many", "https://many.example/llms.txt"))
    const big = await repoHarness(runtime, {
      actor: null,
      pages: { "https://many.example/llms.txt": markdown(`# Many\n\n${many}`) },
      github: h.github,
    })
    const pagesOf = async (response: Response) => ((await response.json()) as { pages: Array<unknown> }).pages
    const listed = await pagesOf(await big.fetch(docsRoute("acme", "many")))
    expect(listed).toHaveLength(MAX_LISTED)
    expect(listed[0]).toEqual({ title: "Retry 0", path: "/p/0.md" })
    expect(await pagesOf(await big.fetch(docsRoute("acme", "many", "retry")))).toHaveLength(SEARCH_LIMIT)
  })

  test("falls back to the curated home's docs when the repository's own home names none, or GitHub can't answer", async () => {
    const h = await open({ homes: [curated("acme/plain", INDEX), curated("acme/down", INDEX)] })
    h.github.publish("acme", "plain", homed("acme/plain"))
    expect((await h.fetch(docsRoute("acme", "plain"))).status).toBe(200)
    h.github.publish("acme", "down")
    h.github.fail("", 502)
    expect((await h.fetch(docsRoute("acme", "down"))).status).toBe(200)
    expect(h.line("repo.docs").map((line) => line.annotations.source)).toEqual(["curated", "curated"])
  })

  test("refuses honestly: no docs, no repository, GitHub down, a docs site that doesn't answer, and bad requests", async () => {
    const h = await open()
    h.github.publish("acme", "plain", homed("acme/plain"))
    h.github.publish("acme", "bare", spoonKnife({ fullName: "acme/bare" }))
    h.github.publish("acme", "odd", spoonKnife({ fullName: "acme/odd", home: { text: "not a home" } }))
    h.github.publish("acme", "gone-docs", homed("acme/gone-docs", "https://offline.example/llms.txt"))
    h.github.publish("acme", "broken-docs", homed("acme/broken-docs", "https://broken.example/llms.txt"))
    const broken = await repoHarness(runtime, {
      actor: null,
      github: h.github,
      pages: { "https://broken.example/llms.txt": { status: 410 } },
    })
    const answer = async (response: Response) => [response.status, await response.json()]

    expect(await answer(await h.fetch(docsRoute("acme", "plain")))).toEqual([404, { code: "no_docs" }])
    expect(await answer(await h.fetch(docsRoute("acme", "bare")))).toEqual([404, { code: "no_docs" }])
    expect(await answer(await h.fetch(docsRoute("acme", "odd")))).toEqual([404, { code: "no_docs" }])
    expect(await answer(await h.fetch(docsRoute("acme", "missing")))).toEqual([404, { code: "not_found" }])
    expect(await answer(await h.fetch(docsRoute("acme", "gone-docs")))).toEqual([
      502,
      { code: "docs_unreachable", reason: "unreachable" },
    ])
    expect(await answer(await broken.fetch(docsRoute("acme", "broken-docs")))).toEqual([
      502,
      { code: "docs_unreachable", reason: "status" },
    ])
    expect(await answer(await h.fetch(docsRoute("acme", "widgets", "x".repeat(201))))).toEqual([400, { code: "invalid" }])
    expect(await answer(await h.fetch(docsRoute("app", "widgets")))).toEqual([404, { code: "not_found" }])
    expect((await h.fetch(docsRoute("acme", "widgets"), { method: "POST" })).status).toBe(405)

    h.github.publish("acme", "down")
    h.github.fail("", 502)
    const down = await h.fetch(docsRoute("acme", "down"))
    expect([down.status, down.headers.get("retry-after"), await down.json()]).toEqual([503, "5", { code: "unavailable" }])
    expect(h.line("repo.docs").map((line) => line.annotations.outcome)).toEqual([
      "no_docs",
      "no_docs",
      "no_docs",
      "not_found",
      "docs_unreachable",
      "invalid",
      "not_found",
      "method",
      "unavailable",
    ])
  })

  test("a deployment whose GitHub URL isn't one answers 503, logged by the defect's name", async () => {
    const h = await open({ config: { GITHUB_API_URL: "not a url" } })
    expect((await h.fetch(docsRoute("acme", "widgets"))).status).toBe(503)
    expect(h.only("docs.source").annotations).toMatchObject({ errorCode: expect.any(String) })
  })

  test("keeps the index for DOCS_KEPT, then asks the docs site again", async () => {
    const config: Record<string, string> = { DOCS_KEPT: "1 millis" }
    const h = await open({ config })
    delete config.DOCS_KEPT
    await h.fetch(docsRoute("acme", "widgets"))
    // The next window: wait on the clock, never a fixed sleep.
    const read = Date.now()
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(read + 1))
    await h.fetch(docsRoute("acme", "widgets"))
    expect(h.asked).toEqual([INDEX, INDEX])
  })
})

describe("GET /api/repos/<owner>/<name>/docs/page", () => {
  test("answers a page the index lists, with its Markdown, kept for a while", async () => {
    const h = await open()
    const response = await h.fetch(docsPageRoute("acme", "widgets", "/guide/retrying.md"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      title: "Retrying",
      path: "/guide/retrying.md",
      url: "https://docs.example/guide/retrying.md",
      text: RETRYING,
    })
    await h.fetch(docsPageRoute("acme", "widgets", "/guide/retrying.md"))
    expect(h.asked).toEqual([INDEX, "https://docs.example/guide/retrying.md"])
    expect(h.line("repo.docs.page").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ outcome: "ok", status: 200, cached: false, characters: RETRYING.length }),
      expect.objectContaining({ outcome: "ok", status: 200, cached: true }),
    ])
    expect(h.count(DocsApi.requests, { route: "page", status: "200" })).toBe(2)
  })

  test("never reads what the index doesn't list: another path, another site, or a URL", async () => {
    const h = await open()
    const answer = async (path: string) => {
      const response = await h.fetch(docsPageRoute("acme", "widgets", path))
      return [response.status, await response.json()]
    }
    expect(await answer("/guide/missing.md")).toEqual([404, { code: "page_not_found" }])
    expect(await answer("/steal.md")).toEqual([404, { code: "page_not_found" }])
    expect(await answer("https://evil.example/steal.md")).toEqual([400, { code: "invalid" }])
    expect(await answer(`/${"a".repeat(1024)}`)).toEqual([400, { code: "invalid" }])
    expect((await h.fetch("/api/repos/acme/widgets/docs/page")).status).toBe(400)
    // Only the index was read.
    expect(h.asked).toEqual([INDEX])
    expect(await answer("/reference/schedule.md")).toEqual([
      502,
      { code: "docs_unreachable", reason: "unreachable" },
    ])
    h.github.publish("acme", "plain", homed("acme/plain"))
    const plain = await h.fetch(docsPageRoute("acme", "plain", "/guide/retrying.md"))
    expect([plain.status, await plain.json()]).toEqual([404, { code: "no_docs" }])
  })

  test("refuses a page that redirects off the index's site: its text is never kept as the docs site's", async () => {
    const h = await open({
      pages: {
        ...site,
        "https://docs.example/guide/start.md": { status: 302, headers: { location: "https://evil.example/start.md" } },
        "https://evil.example/start.md": markdown("# Not the docs\n"),
      },
    })
    const response = await h.fetch(docsPageRoute("acme", "widgets", "/guide/start.md"))
    expect([response.status, await response.json()]).toEqual([502, { code: "docs_unreachable", reason: "redirects" }])
  })

  test("a docs site that is busy (429 or 5xx) says so, apart from one that answers an error for good", async () => {
    const h = await open({
      pages: {
        ...site,
        "https://docs.example/guide/start.md": { status: 503 },
        "https://docs.example/reference/schedule.md": { status: 429 },
        "https://docs.example/guide/retrying.md": { status: 404 },
      },
    })
    const answer = async (path: string) => {
      const response = await h.fetch(docsPageRoute("acme", "widgets", path))
      return [response.status, await response.json()]
    }
    expect(await answer("/guide/start.md")).toEqual([502, { code: "docs_unreachable", reason: "busy" }])
    expect(await answer("/reference/schedule.md")).toEqual([502, { code: "docs_unreachable", reason: "busy" }])
    expect(await answer("/guide/retrying.md")).toEqual([502, { code: "docs_unreachable", reason: "status" }])
  })

  test("refuses a page over 512 KiB rather than cut it", async () => {
    const h = await open({
      pages: {
        ...site,
        "https://docs.example/guide/start.md": markdown("x".repeat(MAX_PAGE_BYTES + 1)),
      },
    })
    const response = await h.fetch(docsPageRoute("acme", "widgets", "/guide/start.md"))
    expect([response.status, await response.json()]).toEqual([502, { code: "docs_unreachable", reason: "too_large" }])
  })

  test("no record carries a query, a path, a URL, a title or a page's text", async () => {
    const h = await open()
    await h.fetch(docsRoute("acme", "widgets", SENTINEL))
    await h.fetch(docsPageRoute("acme", "widgets", "/guide/retrying.md"))
    await h.fetch(docsPageRoute("acme", "widgets", `/${SENTINEL}.md`))
    const all = recorded(h)
    for (const secret of [SENTINEL, "docs.example", "/guide/", "Retrying"]) expect(all).not.toContain(secret)
  })
})

describe("handles", () => {
  test("only the two docs routes of a repository", () => {
    expect(DocsApi.handles("/api/repos/acme/widgets/docs")).toBe(true)
    expect(DocsApi.handles("/api/repos/acme/widgets/docs/page")).toBe(true)
    expect(DocsApi.handles("/api/repos/acme/widgets/docs/other")).toBe(false)
    expect(DocsApi.handles("/api/repos/acme/widgets/docs/page/x")).toBe(false)
    expect(DocsApi.handles("/api/repos/acme/widgets/about")).toBe(false)
    expect(DocsApi.handles("/api/other/acme/widgets/docs")).toBe(false)
    expect(DocsApi.handles("/api/repos/%E0%A4%A/x/docs")).toBe(false)
  })
})
