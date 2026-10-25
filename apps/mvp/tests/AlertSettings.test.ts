// @vitest-environment happy-dom
import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"
import { SpendAlertEntries } from "../src/features/spend/components/SpendAlertEntries"
import { AlertSettings } from "../src/features/spend/components/AlertSettings"
import { SpendProvider } from "../src/features/spend/components/SpendContext"
import { channelsQuery, deliveriesQuery, openQuery, savesQuery } from "../src/features/spend/queries"
import { AlertChannel, AlertDelivery, ChannelSave, Seen, SpendAlert } from "../src/features/spend/schema"
import type { SpendView } from "../src/features/spend/spend"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Exercise the real React view and live queries with row fixtures, without a network or module replacements.
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

const settings = async (initial: ReadonlyArray<AlertChannel>, showAlerts = false) => {
  const scope = Effect.runSync(Scope.make())
  disposals.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const rows = await Effect.runPromise(Scope.provide(scope)(Effect.gen(function* () {
    const channels = yield* Collection.local({
      id: "settings-channels", schema: AlertChannel, getKey: (row) => row.channel, initialData: initial,
    })
    const deliveries = yield* Collection.local({
      id: "settings-deliveries", schema: AlertDelivery, getKey: (row) => `${row.alertId}:${row.channel}`,
    })
    const saves = yield* Collection.local({
      id: "settings-saves", schema: ChannelSave, getKey: (row) => row.channel,
    })
    const alerts = yield* Collection.local({ id: "settings-alerts", schema: SpendAlert, getKey: (row) => row.id })
    const seen = yield* Collection.local({ id: "settings-seen", schema: Seen, getKey: (row) => row.kind })
    const queries: SpendView["queries"] = {
      channels: (yield* channelsQuery(channels)).tanstack,
      receipts: (yield* deliveriesQuery(deliveries)).tanstack,
      saves: (yield* savesQuery(saves)).tanstack,
      open: (yield* openQuery(alerts, seen)).tanstack,
    }
    return { channels, alerts, queries }
  })))
  // The view's output boundary: keep the submitted command, so assertions check what Save actually receives.
  const submitted: Array<{ channel: string; destinations: ReadonlyArray<string> }> = []
  const hidden: Array<string> = []
  const expanded: Array<string> = []
  const view: SpendView = {
    queries: rows.queries,
    actions: {
      hide: (id) => { hidden.push(id) },
      setChannel: (channel, destinations) => { submitted.push({ channel, destinations }) },
    },
  }
  const container = document.createElement("div")
  document.body.append(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(SpendProvider, { value: view }, showAlerts ? createElement(SpendAlertEntries, { expanded: null, onExpand: (id: string) => { expanded.push(id) } }) : createElement(AlertSettings)))
  })
  disposals.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  return { ...rows, run, container, submitted, hidden, expanded }
}

test.each([
  ["email", "saved@example.com", "draft@example.com", "remote@example.com"],
  ["telegram", "@saved", "@draft", "@remote"],
] as const)("a synced %s update preserves unsaved input, focus and the submitted destinations", async (name, saved, draft, remote) => {
  const tab = await settings([{ channel: name, destinations: [saved], updatedAt: "2026-10-21T00:00:00Z" }])
  const input = () => tab.container.querySelector<HTMLInputElement>(`#alert-channel-${name}`)!
  expect(input().value).toBe(saved)
  const editing = input()
  editing.focus()
  editing.value = draft
  editing.dispatchEvent(new Event("input", { bubbles: true }))

  await act(async () => {
    await tab.run(tab.channels.update(name, (row) => {
      row.destinations = [remote]
      row.updatedAt = "2026-10-21T00:01:00Z"
    }))
  })
  expect(tab.queries.channels.toArray[0]?.destinations).toEqual([remote])
  expect(input().value).toBe(draft)
  expect(input()).toBe(editing)
  expect(document.activeElement).toBe(editing)

  await act(async () => editing.form!.requestSubmit())
  expect(tab.submitted).toEqual([{ channel: name, destinations: [draft] }])
})

test.each([
  ["email", ["saved@example.com"], ["remote@example.com"]],
  ["email", ["saved@example.com", "ops@example.com"], ["remote@example.com", "alerts@example.com"]],
  ["telegram", ["@saved"], ["@remote"]],
] as const)("an untouched %s field at %j follows synced settings", async (name, before, after) => {
  const tab = await settings([{ channel: name, destinations: before, updatedAt: "2026-10-21T00:00:00Z" }])
  const input = () => tab.container.querySelector<HTMLInputElement>(`#alert-channel-${name}`)!
  expect(input().value).toBe(before.join(","))
  await act(async () => {
    await tab.run(tab.channels.update(name, (row) => {
      row.destinations = [...after]
      row.updatedAt = "2026-10-21T00:01:00Z"
    }))
  })
  expect(input().value).toBe(after.join(","))
})


test("spend backlog renders panel entries, never page-space toasts", async () => {
  const tab = await settings([], true)
  await act(async () => {
    for (let i = 0; i < 283; i++) await tab.run(tab.alerts.insert({
      id: `alert-${i}`, kind: "model", windowStart: "2026-10-25T00:00:00Z",
      windowEnd: "2026-10-25T00:15:00Z", createdAt: "2026-10-25T00:15:00Z",
      calls: 1, tokens: 12340, costUsd: 0.02, roles: [], dayTokens: 12340, budget: 100000,
    }))
  })
  expect(tab.container.querySelectorAll('[data-slot="notification"]')).toHaveLength(283)
  expect(tab.container.querySelectorAll('[data-slot="toast"]')).toHaveLength(0)
  expect(tab.container.textContent).toContain("Model spend")
  const first = tab.container.querySelector('[data-slot="notification"]')!
  await act(async () => {
    first.querySelector<HTMLButtonElement>('[data-slot="notification-row"]')!.click()
  })
  expect(tab.expanded).toEqual([first.getAttribute("data-entry")])
  await act(async () => { first.querySelector<HTMLButtonElement>('button[aria-label="Hide"]')!.click() })
  expect(tab.hidden).toEqual([first.getAttribute("data-entry")])
})
