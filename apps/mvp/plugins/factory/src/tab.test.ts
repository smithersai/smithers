// The factory's tab (plugins/factory/src/tab.ts) over an injected host (TEST-7) whose feed queries answer the rows a
// test pushes, kept to the `params` asked as the core keeps them (src/plugins/plugins.ts, `queryOf`): each
// repository's status from its own documents only, an on-demand document followed while it shows, the ask the strip
// answers (a `core/feed-items` row of `for_will` that the status says waits), and the views it opens.
import { Host } from "@smthrs/plugin"
import { Deferred, Effect, Layer, Stream } from "effect"
import { describe, expect, test, vi } from "vitest"
import { ASKS, type AskRow, DOCUMENT, type FeedDocument, INDEX, type Params } from "./feeds"
import { hrefOf, tab } from "./tab"

const vibelang = { owner: "smithersai", name: "vibelang" }
const other = { owner: "octo", name: "hello" }

const doc = (repo: string, name: string, body: unknown): FeedDocument => ({
  id: `${repo}:${name}`,
  repo,
  name,
  visibility: "public",
  body,
  updatedAt: "2026-10-30T07:00:00Z",
})

const ask = (item: string, repo = "smithersai/vibelang"): AskRow => {
  const [owner = "", name = ""] = repo.split("/")
  return { key: `${repo}:for_will:${item}`, repo, owner, name, document: "for_will", item, options: ["accept", "change"], answer: `answer-${item}` }
}

/** `for_will` of `repo`, with these decisions waiting and `decided` decided by the agent. */
const decisions = (repo: string, waiting: ReadonlyArray<string>, decided: ReadonlyArray<string> = []) =>
  doc(repo, "for_will", [
    ...waiting.map((id) => ({ id, kind: "decide" })),
    ...decided.map((id) => ({ id, kind: "decide", decided: "by the agent" })),
  ])

/**
 * A host whose queries answer `rows[name]` of the repository and document `params` name, refuse the names in
 * `refused`, answer a document named in `held` only once `release` is called, as a shape still opening does, and
 * record what the tab asked of it.
 */
const hostWith = (refused: ReadonlyArray<string> = [], held: ReadonlyArray<string> = []) => {
  const gate = Effect.runSync(Deferred.make<void>())
  const release = () => Effect.runSync(Deferred.succeed(gate, undefined))
  const rows = new Map<string, Array<unknown>>([[INDEX, []], [DOCUMENT, []], [ASKS, []]])
  const listeners = new Set<() => void>()
  const asked: Array<unknown> = []
  const push = (name: string, ...added: Array<unknown>) => {
    rows.set(name, [...rows.get(name)!, ...added])
    for (const listener of listeners) listener()
  }
  const drop = (name: string, keep: (row: never) => boolean) => {
    rows.set(name, rows.get(name)!.filter((row) => keep(row as never)))
    for (const listener of listeners) listener()
  }
  const refuse = (detail: string) => new Host.PluginRefused({ plugin: "factory", reason: "undeclared_query", detail })
  const layer = Layer.succeed(
    Host.PluginHost,
    Host.PluginHost.of({
      query: <R>(name: string, params?: Params) =>
        refused.includes(name)
          ? Effect.fail(refuse(name))
          : Effect.as(held.includes(params?.name ?? "") ? Deferred.await(gate) : Effect.void, {
            current: () =>
              rows.get(name)!.filter((row) => {
                // An item row names its document `document`; its `name` is the repository's.
                const { repo, name: named, document = named } = row as {
                  readonly repo: string
                  readonly name?: string
                  readonly document?: string
                }
                return repo === params?.repo && (params.name === undefined || document === params.name)
              }) as ReadonlyArray<R>,
            subscribe: (listener: () => void) => {
              listeners.add(listener)
              return () => void listeners.delete(listener)
            },
          }),
      select: (item) => Effect.sync(() => void asked.push({ select: item })),
      propose: () => Effect.void,
      dispatch: (event, fields) =>
        Effect.sync(() => {
          asked.push({ dispatch: event, fields })
          return { runId: "run-1", settled: Effect.succeed({ _tag: "Done" as const }) }
        }),
      open: (view, repository) => Effect.sync(() => void asked.push({ open: view, repository })),
      events: () => Stream.empty,
    }),
  )
  return { layer, push, drop, asked, listeners, release }
}

const withTab = <A>(host: ReturnType<typeof hostWith>, body: (built: Effect.Success<typeof tab>) => Promise<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(tab, (built) => Effect.promise(() => body(built)))).pipe(Effect.provide(host.layer)))

describe("a repository's feed", () => {
  test("its status comes from its own documents only, and changes as the collector pushes", async () => {
    const host = hostWith()
    await withTab(host, async (built) => {
      const feed = built.queries.feed(vibelang)
      // The same repository is one live value, so React reads a stable snapshot.
      expect(built.queries.feed(vibelang)).toBe(feed)
      await vi.waitFor(() => expect(feed.current()).toMatchObject({ _tag: "Ready", documents: 0 }))
      let heard = 0
      const stop = feed.subscribe(() => heard++)
      host.push(INDEX, doc("smithersai/vibelang", "agents", [{ name: "lane-1", state: "running" }]), doc("octo/hello", "agents", [{ name: "theirs" }]))
      host.push(INDEX, doc("smithersai/vibelang", "at", 1793343638))
      stop()
      const ready = feed.current()
      if (ready._tag !== "Ready") throw new Error("not ready")
      expect(ready.documents).toBe(2)
      expect(ready.status.agents.map((agent) => agent.name)).toEqual(["lane-1"])
      expect(ready.status.at).toBe(1793343638)
      expect(heard).toBe(2)
      await vi.waitFor(() => expect(built.queries.feed(other).current()).toMatchObject({ _tag: "Ready", documents: 1 }))
      // Feeds key a repository lowercased, as GitHub's names are case-insensitive.
      const cased = built.queries.feed({ owner: "SmithersAI", name: "VibeLang" })
      await vi.waitFor(() => expect(cased.current()).toMatchObject({ _tag: "Ready", documents: 2 }))
    })
    // The tab's scope closed: it follows nothing any more.
    expect(host.listeners.size).toBe(0)
  })

  test("a feed the host refuses says so, and the asks stay empty", async () => {
    await withTab(hostWith([INDEX, ASKS]), async (built) => {
      await vi.waitFor(() => expect(built.queries.feed(vibelang).current()).toEqual({ _tag: "Refused", reason: "undeclared_query" }))
      expect(built.queries.asks(vibelang).current()).toEqual([])
      expect(built.queries.selected.current()).toBeNull()
    })
  })
})

describe("an opened document", () => {
  test("shows at once, gets its body when the collector pushes it, and closing stops following it", async () => {
    const host = hostWith()
    await withTab(host, async (built) => {
      const { opened } = built.queries
      expect(opened.current()).toBeNull()
      built.actions.read(vibelang, "transcript", "transcript/lane-1", "lane-1")
      expect(opened.current()).toEqual({ kind: "transcript", title: "lane-1", name: "transcript/lane-1", body: undefined })
      await vi.waitFor(() => expect(host.listeners.size).toBe(1))
      // Another repository's document of the same name, or another document, is not this one.
      host.push(DOCUMENT, doc("octo/hello", "transcript/lane-1", { events: [] }), doc("smithersai/vibelang", "transcript/lane-2", {}))
      expect(opened.current()?.body).toBeUndefined()
      host.push(DOCUMENT, doc("smithersai/vibelang", "transcript/lane-1", { live: true, events: [{ kind: "text", text: "hi" }] }))
      await vi.waitFor(() => expect(opened.current()?.body).toEqual({ live: true, events: [{ kind: "text", text: "hi" }] }))
      // Opening another replaces it; the first one is no longer followed.
      built.actions.read(vibelang, "diff", "diff/abc", "fix: things")
      await vi.waitFor(() => expect(opened.current()).toEqual({ kind: "diff", title: "fix: things", name: "diff/abc", body: undefined }))
      await vi.waitFor(() => expect(host.listeners.size).toBe(1))
      built.actions.close()
      expect(opened.current()).toBeNull()
      await vi.waitFor(() => expect(host.listeners.size).toBe(0))
      built.actions.close()
      expect(opened.current()).toBeNull()
    })
  })

  test("a document still opening when the person opened another never shows over it", async () => {
    const host = hostWith([], ["transcript/slow"])
    await withTab(host, async (built) => {
      host.push(DOCUMENT, doc("smithersai/vibelang", "transcript/slow", { events: [] }))
      built.actions.read(vibelang, "transcript", "transcript/slow", "slow")
      built.actions.read(vibelang, "report", "report/r1", "Round 1")
      host.release()
      await vi.waitFor(() => expect(host.listeners.size).toBe(1))
      expect(built.queries.opened.current()).toEqual({ kind: "report", title: "Round 1", name: "report/r1", body: undefined })
    })
  })

  test("a document the host refuses shows as not available", async () => {
    await withTab(hostWith([DOCUMENT]), async (built) => {
      built.actions.read(vibelang, "report", "needs", "Open questions")
      await vi.waitFor(() => expect(built.queries.opened.current()).toMatchObject({ name: "needs", body: null }))
    })
  })
})

describe("the asks the strip answers", () => {
  test("the first open ask is selected; the person's pick holds; an answered one gives way to the next", async () => {
    const host = hostWith()
    const key = (item: string) => `smithersai/vibelang:for_will:${item}`
    const params = { repo: "smithersai/vibelang", name: "for_will" }
    await withTab(host, async (built) => {
      const asks = built.queries.asks(vibelang)
      expect(built.queries.asks(vibelang)).toBe(asks)
      await vi.waitFor(() => expect(asks.current()).toEqual([]))
      expect(built.queries.selected.current()).toBeNull()
      // Only what the status says waits: `d` the agent decided.
      host.push(INDEX, decisions("smithersai/vibelang", ["a", "b", "c"], ["d"]))
      host.push(ASKS, ask("a"), ask("b"), ask("d"), ask("x", "octo/hello"))
      await vi.waitFor(() => expect(asks.current().map((row) => row.item)).toEqual(["a", "b"]))
      await vi.waitFor(() => expect(built.queries.selected.current()).toBe(key("a")))
      built.actions.select(ask("b"))
      expect(built.queries.selected.current()).toBe(key("b"))
      host.push(ASKS, ask("c"))
      expect(built.queries.selected.current()).toBe(key("b"))
      // Answered: the collector reports it, and the strip moves to the first one waiting.
      host.push(INDEX, doc("smithersai/vibelang", "answered", { b: { choice: "accept", text: "", at: 1 } }))
      expect(asks.current().map((row) => row.item)).toEqual(["a", "c"])
      expect(built.queries.selected.current()).toBe(key("a"))
      host.drop(ASKS, (row: AskRow) => row.item !== "a")
      expect(built.queries.selected.current()).toBe(key("c"))
      await vi.waitFor(() =>
        expect(host.asked.filter((entry) => "select" in (entry as object))).toEqual([
          { select: { query: ASKS, key: key("a"), params } },
          { select: { query: ASKS, key: key("b"), params } },
          { select: { query: ASKS, key: key("a"), params } },
          { select: { query: ASKS, key: key("c"), params } },
        ])
      )
    })
  })

  test("asks wait for the status: none while the feed is loading or refused", async () => {
    const host = hostWith([INDEX])
    await withTab(host, async (built) => {
      host.push(ASKS, ask("a"))
      await vi.waitFor(() => expect(built.queries.feed(vibelang).current()).toMatchObject({ _tag: "Refused" }))
      expect(built.queries.asks(vibelang).current()).toEqual([])
      expect(built.queries.selected.current()).toBeNull()
    })
  })
})

describe("moving around", () => {
  test("a view opens on its repository; Docs goes to the repository's docs through its own event", async () => {
    const host = hostWith()
    await withTab(host, async (built) => {
      built.actions.open("factory/agents", vibelang)
      built.actions.go("factory/docs", "/smithersai/vibelang/docs")
      expect(built.actions.href("factory/agents", vibelang)).toBe("/smithersai/vibelang/-/factory/agents")
      await vi.waitFor(() =>
        expect(host.asked).toEqual([
          { open: "factory/agents", repository: vibelang },
          { dispatch: { view: "factory/docs", name: "go" }, fields: { to: "/smithersai/vibelang/docs" } },
        ])
      )
    })
    expect(hrefOf("factory/now", other)).toBe("/octo/hello/-/factory")
  })
})
