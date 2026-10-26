// Custom domains on the tab (docs/features/domains.md#the-settings-section), driven as React drives them: through the
// domains layer's plain actions, reading its live queries, with no React. Each tab runs the browser's own layer
// (`appLayer`) on a Node device (src/test/chatApi.ts) against ChatApi's real handler over the compose Postgres and
// Electric, signed in as a Maintainer or a Member of the test repository. ChatApi's domain flows run on the Node host's
// engine with the `Dns` provider, which finds no records for a name under `.example`, so a domain stays pending.
import { Effect, type ManagedRuntime } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import {
  member,
  nodeDevice,
  type NodeDevice,
  openFaultyApp,
  openTab,
  openTestApp,
  TEST_REPOSITORY,
  TestChatApi,
} from "../../test/chatApi"
import { EngineFaults } from "../../test/faults"
import { read as readTelemetry } from "../../test/otlp"
import { Domains } from "./domains"
import { DomainsStore } from "./store"

const maintainer: Actor = { subject: { kind: "person", id: "person-maintainer" }, role: "maintainer" }
const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]

/** A test's budget: a fresh device's engine starts, then runs each flow, on a loaded machine. */
const BUDGET = 120_000

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** A live query's rows as plain values, without TanStack DB's virtual `$` properties. */
const plain = <A extends object>(rows: ReadonlyArray<A>): Array<A> =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) as A)

const until = (assertion: () => void | Promise<void>, timeout = 60_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

/**
 * A tab signed in as `actor`, on a fresh ChatApi, showing the test repository's Settings page. The tab's device runs
 * its engine against that ChatApi (`agent`), so the flows a press dispatches run: a device without one never leads.
 * `clipboard` replaces the device's own.
 */
const openSettings = async (actor: Actor, clipboard?: NodeDevice["clipboard"]) => {
  const app = openTestApp({ answers: false }, { actor })
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const own = nodeDevice({ agent: api })
  const device: NodeDevice = clipboard === undefined ? own : { ...own, clipboard }
  const runtime: ManagedRuntime.ManagedRuntime<Domains | DomainsStore, unknown> = openTab(api, { host: device })
  runtimes.push(runtime)
  const domains = await runtime.runPromise(Effect.service(Domains))
  const store = await runtime.runPromise(Effect.service(DomainsStore))
  await domains.actions.open(owner, name)
  for (const query of [store.listState, store.savesState, store.pageState]) query.tanstack.startSyncImmediate()
  return {
    domains,
    store,
    device,
    list: () => plain(store.listState.tanstack.toArray),
    saves: () => plain(store.savesState.tanstack.toArray),
    page: () => plain(store.pageState.tanstack.toArray),
    api,
    /** Closes the tab, which flushes its exporter. */
    close: () => runtime.dispose(),
  }
}

describe("a Maintainer's Settings page", () => {
  test("adds a domain: Adding… until ChatApi takes it, then its row: pending, with the CNAME to add", { timeout: BUDGET }, async () => {
    const tab = await openSettings(maintainer)
    expect(tab.page()).toEqual([{ id: "page", owner, name }])
    tab.domains.actions.add("  Docs.VibeLang-E2E.example. ")
    expect(tab.saves()).toEqual([{ hostname: "docs.vibelang-e2e.example", op: "add", state: "saving", code: null }])
    await until(() => expect(tab.saves()).toEqual([]))
    await until(() =>
      expect(tab.list()).toMatchObject([
        {
          hostname: "docs.vibelang-e2e.example",
          state: "pending",
          verification: "pending",
          certificate: "unmanaged",
          records: [expect.objectContaining({ type: "CNAME", name: "docs.vibelang-e2e.example" })],
        },
      ])
    )

    // Refresh checks it again; the row stays.
    tab.domains.actions.refresh("docs.vibelang-e2e.example")
    expect(tab.saves()).toMatchObject([{ op: "refresh", state: "saving" }])
    await until(() => expect(tab.saves()).toEqual([]))

    // Remove takes it off the list.
    tab.domains.actions.remove("docs.vibelang-e2e.example")
    await until(() => expect(tab.list()).toEqual([]))
  })

  test("a name that can't be a domain is refused on the tab, unsent", async () => {
    const tab = await openSettings(maintainer)
    tab.domains.actions.add("https://vibelang.sh/docs")
    expect(tab.saves()).toEqual([
      { hostname: "https://vibelang.sh/docs", op: "add", state: "failed", code: "invalid_hostname" },
    ])
  })

  test("showing the same repository again keeps its list; another repository's starts empty", { timeout: BUDGET }, async () => {
    const tab = await openSettings(maintainer)
    tab.domains.actions.add("www.vibelang-e2e.example")
    await until(() => expect(tab.list().map((row) => row.hostname)).toEqual(["www.vibelang-e2e.example"]))
    await tab.domains.actions.open(owner, name)
    expect(tab.list().map((row) => row.hostname)).toEqual(["www.vibelang-e2e.example"])
    await tab.domains.actions.open("someone", "else")
    expect(tab.list()).toEqual([])
    expect(tab.page()).toEqual([{ id: "page", owner: "someone", name: "else" }])
    // Back again: the repository's shape, already open, fills the list.
    await tab.domains.actions.open(owner, name)
    await until(() => expect(tab.list().map((row) => row.hostname)).toEqual(["www.vibelang-e2e.example"]))
  })

  test("Copy puts a record's value on the clipboard", async () => {
    const tab = await openSettings(maintainer)
    await tab.domains.actions.copy("domains.localhost")
    expect(tab.device.copied).toEqual(["domains.localhost"])
  })

  test("Copy rejects when the clipboard refuses, so the button says so", async () => {
    const tab = await openSettings(maintainer, () => Promise.reject(new Error("no focus")))
    await expect(tab.domains.actions.copy("domains.localhost")).rejects.toBeDefined()
    await tab.close()
    // Logged once at Warn by the refusal's code, never the value or the clipboard's message.
    const lines = readTelemetry(tab.api.telemetry).log("domain.copy")
    expect(lines).toEqual([
      expect.objectContaining({
        severity: "Warn",
        attributes: expect.objectContaining({ feature: "domains", outcome: "failed", errorCode: "ClipboardRefused" }),
      }),
    ])
    expect(JSON.stringify(lines)).not.toMatch(/domains\.localhost|no focus/)
  })
})

describe("an engine that can't run the write", () => {
  test("the write shows it couldn't be saved, to be tried again", async () => {
    const runtime = openFaultyApp({ answers: false }, undefined, { actor: maintainer })
    runtimes.push(runtime)
    const engine = await runtime.runPromise(Effect.service(EngineFaults))
    await runtime.runPromise(engine.refuseStarts("domain/add"))
    const domains = await runtime.runPromise(Effect.service(Domains))
    const store = await runtime.runPromise(Effect.service(DomainsStore))
    store.savesState.tanstack.startSyncImmediate()
    await domains.actions.open(owner, name)
    domains.actions.add("docs.vibelang-e2e.example")
    await until(() =>
      expect(plain(store.savesState.tanstack.toArray)).toEqual([
        { hostname: "docs.vibelang-e2e.example", op: "add", state: "failed", code: "unavailable" },
      ])
    )
  })
})

describe("a Member", () => {
  test("syncs no domains, and an add is refused: only Maintainers change domains", { timeout: BUDGET }, async () => {
    const tab = await openSettings(member)
    tab.domains.actions.add("docs.vibelang-e2e.example")
    await until(() =>
      expect(tab.saves()).toEqual([
        { hostname: "docs.vibelang-e2e.example", op: "add", state: "failed", code: "forbidden" },
      ])
    )
    expect(tab.list()).toEqual([])
  })
})
