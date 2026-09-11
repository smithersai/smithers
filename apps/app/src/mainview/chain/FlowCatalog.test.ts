import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import type { Event, Outcome } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { USER_ONLY_VISIBLE } from "../flows/Flows"
import type { AppStore } from "../state/AppStore"
import { commandEntries, disclosedEntries } from "./FlowCatalog"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const idleAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, idleAgent)
  return { store, commands: controller.commands }
}

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const runChain = (options: {
  readonly store: AppStore
  readonly entries: ReadonlyArray<Catalog.Entry>
  readonly scripts: ReadonlyArray<string>
}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const outcome = yield* Chain.run({ goal: "test goal" })
      const journal = yield* Journal.Journal
      const events = yield* journal.read
      return { outcome, events }
    }).pipe(
      Effect.provide(
        (() => {
          const base = Layer.mergeAll(
            Journal.layerMemory([]),
            Author.layerMock(options.scripts),
            ScriptRunner.layerInProcess
          )
          return Layer.mergeAll(
            base,
            Catalog.layer(options.entries).pipe(Layer.provide(base))
          )
        })()
      )
    ) as Effect.Effect<
      { outcome: Outcome.Terminal; events: ReadonlyArray<Event.Event> },
      never,
      never
    >
  )

describe("commandEntries — the callable projection", () => {
  test("projects every non-user command, hidden id-scoped actions included", async () => {
    const { commands } = await harness()
    const names = commandEntries(commands).map((entry) => entry.name)
    expect(names).toContain("browser.open")
    expect(names).toContain("world.new-note")
    expect(names).not.toContain("approval.approve")
    expect(names).not.toContain("approval.deny")
    // Re-pinned 2026-09-01. This asserted that `theme` was unreachable until
    // 1e18cb3339 narrowed the user-only set to USER_ONLY_VISIBLE, so that every
    // flow the slash menu lists is also a tool call. Appearance, surfaces and
    // verbose became callable then; the enumerated set is what still is not, so
    // the assertion now reads that list rather than restating three names.
    expect(names).toContain("appearance.theme")
    expect(names).toContain("chat.surfaces")
    for (const { name } of USER_ONLY_VISIBLE) expect(names).not.toContain(name)
    expect(names).not.toContain("send")
    expect(names).not.toContain("chat.stop")
    // Admin commands are absent for a non-admin session (non-enumerable).
    expect(names).not.toContain("reset")
    expect(names).not.toContain("debug.snapshot")
  })

  test("disclosedEntries is the unhidden subset the list action returns today", async () => {
    const { commands } = await harness()
    const disclosed = disclosedEntries(commands).map((entry) => entry.name)
    expect(disclosed).toContain("browser.open")
    expect(disclosed).not.toContain("world.new-note")
    const callable = new Set(commandEntries(commands).map((entry) => entry.name))
    for (const name of disclosed) expect(callable.has(name)).toBe(true)
  })
})

describe("commandEntries — execution through the one door", () => {
  test("a script's call runs the real command as actor smithers", async () => {
    const { store, commands } = await harness()
    const before = store.collections.worldDocuments.size
    const { outcome } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [flow(`await ctx.call("world.new-note", {})`, `return done({ noted: true })`)]
    })
    expect(outcome._tag).toBe("Done")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    const created = [...store.collections.worldDocuments.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt
    )[0]
    expect(created?.updatedBy).toBe("smithers")
  })

  test("a command's honest failure string becomes a journaled observation, not a crash", async () => {
    const { store, commands } = await harness()
    const { outcome, events } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [
        // card.dismiss on a card that does not exist fails with the command's own message
        // (a call WITHOUT its required input renders the flow's form instead — THE FORM LAW).
        flow(`await ctx.call("card.dismiss", { args: "nope" })`, `return done({})`),
        flow(`return done({ recovered: true })`)
      ]
    })
    expect(outcome._tag).toBe("Done")
    const rejections = events.filter((event) => event._tag === "GateRejected")
    expect(rejections.length).toBeGreaterThan(0)
    expect(JSON.stringify(rejections)).toContain("There is no card nope.")
  })

  test("a call to a name outside the catalog is gate 3's rejection", async () => {
    const { store, commands } = await harness()
    const { outcome, events } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [
        // Re-pinned 2026-09-01: `theme` entered the catalog with 1e18cb3339, so
        // the name outside it is now a user-only one, `chat.send`.
        flow(`await ctx.call("chat.send", {})`, `return done({})`),
        flow(`return done({ recovered: true })`)
      ]
    })
    expect(outcome._tag).toBe("Done")
    expect(events.some((event) => event._tag === "GateRejected")).toBe(true)
  })

  test("a malformed payload is a typed CallError before any execution", async () => {
    const { commands } = await harness()
    const entry = commandEntries(commands).find((candidate) => candidate.name === "world.new-note")
    expect(entry).toBeDefined()
    const error = await Effect.runPromise(
      Effect.flip(entry!.handler({ args: 42 })) as Effect.Effect<Catalog.CallError, never, never>
    )
    expect(error._tag).toBe("/chain/CallError")
    expect(error.message).toContain("args must be a string")
  })
})
