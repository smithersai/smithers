// @vitest-environment happy-dom
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { AttentionProvider } from "../src/features/attention/components/AttentionContext"
import { Notices } from "../src/features/attention/components/Notices"
import { Attention } from "../src/features/attention/attention"
import { detailQuery, feedQuery, listQuery, needsQuery, panelQuery, stackQuery, unreadQuery } from "../src/features/attention/queries"
import { Detail, Entry, Panel } from "../src/features/attention/schema"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test("283 unread entries reserve no page space; only three live notices render", async () => {
  const scope = Effect.runSync(Scope.make())
  const data = await Effect.runPromise(Scope.provide(scope)(Effect.gen(function* () {
    const entries = yield* Collection.local({ id: "backlog", schema: Entry, getKey: (row) => row.id,
      initialData: Array.from({ length: 283 }, (_, i) => ({
        id: `notice-${i}`, kind: "run" as const, state: "done" as const, mine: true,
        runId: null, conversationId: null, actor: null, atMs: i, word: null, detail: null,
        action: "open" as const, href: "/app", version: 1, unread: true, settled: true,
        stack: false, stackHere: false, listed: true, here: false, order: i,
      })),
    })
    const panels = yield* Collection.local({ id: "backlog-panel", schema: Panel, getKey: (row) => row.id })
    const details = yield* Collection.local({ id: "backlog-detail", schema: Detail, getKey: (row) => row.id })
    const unexpected = () => { throw new Error("No interaction expected") }
    return { entries, view: Attention.of({ queries: {
      stack: (yield* stackQuery(entries, "stack")).tanstack,
      stackHere: (yield* stackQuery(entries, "stackHere")).tanstack,
      list: (yield* listQuery(entries, "stack")).tanstack,
      listHere: (yield* listQuery(entries, "stackHere")).tanstack,
      feed: (yield* feedQuery(entries)).tanstack, unread: (yield* unreadQuery(entries)).tanstack,
      needs: (yield* needsQuery(entries)).tanstack, panel: (yield* panelQuery(panels)).tanstack,
      detail: (yield* detailQuery(details)).tanstack,
    }, actions: {
      open: unexpected, hide: unexpected, dismiss: unexpected, read: unexpected,
      answer: unexpected, retry: unexpected, openPanel: unexpected, togglePanel: unexpected,
      closePanel: unexpected, expand: unexpected,
    } }) }
  })))
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AttentionProvider, { value: data.view },
      createElement(Notices, { surface: "page", placement: "inline" }))))
    expect(data.entries.tanstack.toArray).toHaveLength(283)
    expect(data.entries.tanstack.toArray.every((entry) => entry.unread)).toBe(true)
    expect(container.childElementCount).toBe(0)
    await act(async () => {
      for (let i = 0; i < 5; i++) await Effect.runPromise(data.entries.update(`notice-${i}`, (row) => {
        row.state = "working"
        row.stack = true
      }))
    })
    expect(container.querySelectorAll('[data-slot="toast"]')).toHaveLength(3)
    expect(container.querySelectorAll('.sui-toast-more')).toHaveLength(0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
