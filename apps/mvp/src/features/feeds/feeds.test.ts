// Repository feeds on a tab (docs/features/feeds.md): a collector's documents, written to ChatApi's real handler over the
// compose Postgres and Electric, reach a plugin through the host's `core/feeds` and `core/feed`; a Maintainer's
// `feed/answer` runs on the device's engine and reaches the collector's read. Only the model is scripted.
import { type Host } from "@smthrs/plugin"
import { Effect, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import queue from "../../../plugins/queue/plugin.json" with { type: "json" }
import { FlowDispatch } from "../../flows/dispatch"
import type { BuiltIn } from "../../plugins/builtin"
import { hostFor, Plugins, queryOf, readable, selectedOf, stateOf } from "../../plugins/plugins"
import { PluginsUi } from "../../plugins/ui"
import { member, nodeDevice, openTab, openTestApp, TEST_FEED_KEY, TestChatApi } from "../../test/chatApi"
import { feedAnswersRoute, feedsRoute } from "./contract"
import type { FeedDocument } from "./schema"
import { documents } from "./store"

const WITHIN = 60_000
const VIEW = "probe/feeds"
/** The test ChatApi's repository (`TEST_REPOSITORY`), as a plugin may name it. */
const REPO = { owner: "octo", name: "hello" } as const
const ASKED = { repo: "Octo/Hello" }

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: WITHIN, interval: 20 })

/** A plugin whose one view reads a repository's feeds. */
const probe: BuiltIn = {
  manifest: {
    ...queue,
    id: "probe",
    uses: [],
    $defs: {},
    contributes: {
      views: [{
        id: VIEW,
        title: "Feeds",
        scope: "app",
        path: "",
        sizes: ["full"],
        minimum: "anyone",
        reads: ["core/feeds", "core/feed"],
        render: { kind: "component", export: "Feeds" },
        events: [],
      }],
    },
  },
  tab: () => Promise.reject(new Error("never loaded")),
  components: () => Promise.reject(new Error("never loaded")),
}

/** ChatApi signed in as a Maintainer of its repository, and a device whose engine leads. */
const open = async () => {
  const root = openTestApp({ answers: false }, { actor: { ...member, role: "maintainer", login: "maya" } })
  runtimes.push(root)
  const api = await root.runPromise(Effect.service(TestChatApi))
  const tab = openTab(api, { host: nodeDevice({ agent: api }) })
  runtimes.push(tab)
  /** A request as the collector sends it, with its feed key. */
  const collector = (path: string, init: RequestInit = {}) =>
    api.fetch(`${api.origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TEST_FEED_KEY}`, "content-type": "application/json" },
    })
  return { api, tab, collector }
}

const names = (live: Host.Live<FeedDocument>) => live.current().map((row) => row.name)

describe("repository feeds on a tab", { timeout: WITHIN * 2 }, () => {
  test("a plugin reads a repository's index, one document only while it listens, and selects a row of the index", async () => {
    const { tab, collector } = await open()
    const written = await collector(feedsRoute(REPO.owner, REPO.name), {
      method: "POST",
      body: JSON.stringify({
        set: {
          lanes: { visibility: "public", body: [{ lane: "server" }] },
          decisions: { visibility: "maintainers", body: [{ id: "decision-1" }] },
          "transcript/server": { visibility: "public", body: { lines: ["started"] } },
          "diff/abc": { visibility: "public", body: "+1" },
        },
      }),
    })
    expect(written.status).toBe(200)
    const count = (outcome: string) => tab.runSync(Metric.value(Metric.withAttributes(documents, { outcome }))).count

    await tab.runPromise(Effect.scoped(Effect.gen(function* () {
      const plugins = yield* Plugins
      const host = yield* hostFor("probe")
      const refused = (effect: Effect.Effect<unknown, Host.PluginRefused>) =>
        Effect.map(Effect.flip(effect), (refusal) => refusal.reason)

      // The index: every document whose name has no `/`, the Maintainer's private ones too; asked once per repository.
      const index = yield* host.query<FeedDocument>("core/feeds", ASKED)
      yield* Effect.promise(() => until(() => expect(names(index)).toEqual(["decisions", "lanes"])))
      expect(yield* host.query("core/feeds", { repo: "octo/hello" })).toBe(index)
      expect(index.current()[1]).toMatchObject({ id: "octo/hello:lanes", repo: "octo/hello", body: [{ lane: "server" }] })

      // One document syncs while a listener holds it, and stops after the last one leaves.
      const transcript = yield* host.query<FeedDocument>("core/feed", { ...ASKED, name: "transcript/server" })
      expect(yield* host.query("core/feed", { ...ASKED, name: "transcript/server" })).toBe(transcript)
      const heard: Array<string> = []
      const first = transcript.subscribe(() => heard.push("first"))
      const second = transcript.subscribe(() => heard.push("second"))
      yield* Effect.promise(() => until(() => expect(transcript.current()).toEqual([expect.objectContaining({ body: { lines: ["started"] } })])))
      expect(heard).toEqual(expect.arrayContaining(["first", "second"]))
      first()
      expect(transcript.current()).toHaveLength(1)
      second()
      second()
      expect(transcript.current()).toEqual([])
      yield* Effect.promise(() => until(() => expect([count("opened"), count("closed")]).toEqual([1, 1])))
      // Another stays open until the tab closes.
      const diff = yield* host.query<FeedDocument>("core/feed", { ...ASKED, name: "diff/abc" })
      diff.subscribe(() => {})
      yield* Effect.promise(() => until(() => expect(names(diff)).toEqual(["diff/abc"])))

      // A parameter a feed query needs, missing or malformed, is refused.
      expect(yield* refused(host.query("core/feeds"))).toBe("invalid_fields")
      expect(yield* refused(host.query("core/feeds", { repo: "octo" }))).toBe("invalid_fields")
      expect(yield* refused(host.query("core/feed", ASKED))).toBe("invalid_fields")
      expect(yield* refused(host.query("core/feed", { ...ASKED, name: "Transcript" }))).toBe("invalid_fields")
      expect(yield* Effect.flip(queryOf("core/runs", undefined))).toBe("query")
      expect(yield* queryOf("core/waits", undefined)).toBe(plugins.core.get("core/waits")!.live)

      // The strip reads the index as the view asked for it; a document is only shown.
      expect(readable(plugins, "core/feeds", ASKED)).toBe(plugins.opened.get("octo/hello"))
      expect(readable(plugins, "core/feeds", null)).toBeUndefined()
      expect(readable(plugins, "core/feed", { ...ASKED, name: "diff/abc" })).toBeUndefined()
      expect(readable(plugins, "core/waits", null)).toBe(plugins.core.get("core/waits"))
      yield* host.select({ query: "core/feeds", key: "octo/hello:lanes", params: ASKED })
      const selected = yield* stateOf(VIEW)
      expect(selected).toMatchObject({ query: "core/feeds", params: ASKED, item: "octo/hello:lanes" })
      expect(yield* selectedOf(VIEW)).toMatchObject({ name: "lanes" })
      // The same row asked the same way changes nothing; asked another way, the strip follows.
      yield* host.select({ query: "core/feeds", key: "octo/hello:lanes", params: ASKED })
      expect(yield* stateOf(VIEW)).toEqual(selected)
      const other = { repo: "octo/hello", name: "ignored" }
      yield* host.select({ query: "core/feeds", key: "octo/hello:lanes", params: other })
      expect(yield* stateOf(VIEW)).toMatchObject({ params: other })
      yield* host.select({ query: "core/feeds", key: "octo/hello:lanes", params: { name: "ignored", repo: "octo/hello" } })
      expect((yield* stateOf(VIEW)).params).toEqual(other)
      expect(yield* refused(host.select({ query: "core/feed", key: "octo/hello:diff/abc", params: { ...ASKED, name: "diff/abc" } })))
        .toBe("not_in_reads")
    }).pipe(Effect.provide(Plugins.layer([probe])))))

    // The app's host has opened no index of its own.
    const ui = await tab.runPromise(Effect.service(PluginsUi))
    expect(ui.actions.core("core/feeds", ASKED)).toBeUndefined()
  })

  test("a Maintainer's answer runs on the device and reaches the collector, once", async () => {
    const { tab, collector } = await open()
    const id = crypto.randomUUID()
    const payload = { ...REPO, id, item: "decision-1", choice: "approve", text: "ship it" }
    const answered = await tab.runPromise(
      Effect.flatMap(FlowDispatch, (flows) => flows.dispatch("feed/answer", payload, { door: "button" })),
    )
    expect(answered).toMatchObject({ _tag: "Done", value: { id, seq: expect.any(Number) } })
    // Sent again, it changes nothing.
    const again = await tab.runPromise(
      Effect.flatMap(FlowDispatch, (flows) => flows.dispatch("feed/answer", payload, { door: "button" })),
    )
    expect(again).toEqual(answered)
    const read = await collector(`${feedAnswersRoute(REPO.owner, REPO.name)}?after=0`)
    expect(read.status).toBe(200)
    const body = await read.json() as { answers: Array<Record<string, unknown>>; next: number }
    expect(body.answers).toEqual([
      expect.objectContaining({ id, item: "decision-1", choice: "approve", text: "ship it", login: "maya" }),
    ])
    expect(body.next).toBe(body.answers[0]!.seq)
  })
})
