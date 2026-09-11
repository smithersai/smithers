import { Author, Authorize, Catalog, Chain, Event, ScriptRunner } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { layerCollection, makeCollectionJournal } from "./CollectionJournal"

const memoryStorage = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value)
    },
    removeItem: (key) => {
      rows.delete(key)
    }
  }
}

const source = (body: string): string => `\`\`\`flow\n${body}\n\`\`\``

const run = (store: AppStore, lineageId: string, scripts: string[], entries: Catalog.Entry[], allowed = true) => {
  const base = Layer.mergeAll(
    layerCollection({ store, lineageId }),
    Author.layerMock(scripts),
    ScriptRunner.layerInProcess,
    Layer.succeed(Authorize.Authorize)(Authorize.make({
      authorize: ({ name }) =>
        name === "protected" && !allowed
          ? Effect.fail(new Authorize.AuthorizeError({ code: "approval_required", message: "Human approval required" }))
          : Effect.void
    }))
  )
  return Effect.runPromise(
    Chain.run({ goal: "retention proof" }).pipe(
      Effect.provide(Layer.mergeAll(base, Catalog.layer(entries).pipe(Layer.provide(base))))
    )
  )
}

// These are real append transactions, not a mocked retention predicate. The
// unrelated lineage remains active while the older lineages are replayed.
const addTraffic = async (store: AppStore): Promise<void> => {
  const journal = makeCollectionJournal({ store, lineageId: "later-traffic" })
  await Effect.runPromise(journal.append({ _tag: "ChainStarted", goal: "traffic", envelope: null }, 0))
  for (let seq = 1; seq <= 1_005; seq += 1) {
    await Effect.runPromise(journal.append({
      _tag: "SteeringDrained",
      link: 0,
      ordinal: seq,
      messages: [`instruction ${seq}`]
    } as Event.Event, seq))
  }
}

describe("authoritative chain journal retention", () => {
  test("account replacement removes private events but permanently refuses their lineage IDs", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    await first.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "alice",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    }).isPersisted.promise
    let effects = 0
    const entries = [{
      name: "edit",
      description: "edit",
      handler: () =>
        Effect.sync(() => {
          effects += 1
          return { ok: true }
        })
    }]
    const scripts = [source("await ctx.call(\"edit\", {}); return done({ ok: true })")]
    await run(first, "old-account-lineage", scripts, entries)
    await first.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "bob",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    }).isPersisted.promise
    expect(first.collections.chainEvents.size).toBe(0)
    const reopened = await createAppStore({ kind: "localStorage", storage })
    await expect(run(reopened, "old-account-lineage", scripts, entries)).rejects.toThrow("retired")
    expect(effects).toBe(1)
    expect((await run(reopened, "new-account-lineage", scripts, entries))._tag).toBe("Done")
    expect(effects).toBe(2)
  })

  test("a completed edit survives >1000 unrelated commits and reload without re-execution", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    let edits = 0
    const entries = [{
      name: "edit",
      description: "edit",
      handler: () =>
        Effect.sync(() => {
          edits += 1
          return { ok: true }
        })
    }]
    const scripts = [source("await ctx.call(\"edit\", {}); return done({ ok: true })")]
    const outcome = await run(first, "completed-edit", scripts, entries)
    expect(outcome._tag).toBe("Done")
    expect(edits).toBe(1)
    const original = await Effect.runPromise(makeCollectionJournal({ store: first, lineageId: "completed-edit" }).read)
    await addTraffic(first)
    expect(first.collections.chainEvents.size).toBeGreaterThan(1_000)
    first.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(await Effect.runPromise(makeCollectionJournal({ store: reopened, lineageId: "completed-edit" }).read))
        .toEqual(original)
      // An empty author fails if replay attempts any new model call.
      expect(await run(reopened, "completed-edit", [], entries)).toEqual(outcome)
      expect(edits).toBe(1)
    } finally {
      reopened.dispose?.()
    }
  }, 30_000)

  test("interleaved approval-parked lineages retain their settled prefixes through traffic and restart", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    let prefixEdits = 0
    let protectedEdits = 0
    const entries = [
      {
        name: "edit",
        description: "edit",
        handler: () =>
          Effect.sync(() => {
            prefixEdits += 1
            return { ok: true }
          })
      },
      {
        name: "protected",
        description: "protected",
        handler: () =>
          Effect.sync(() => {
            protectedEdits += 1
            return { ok: true }
          })
      }
    ]
    const scripts = [
      source("await ctx.call(\"edit\", {}); await ctx.call(\"protected\", {}); return done({ ok: true })")
    ]
    for (const lineage of ["parked-a", "parked-b"]) {
      expect(await run(first, lineage, scripts, entries, false)).toMatchObject({
        _tag: "ApprovalWait",
        reason: { code: "approval" }
      })
    }
    expect(prefixEdits).toBe(2)
    expect(protectedEdits).toBe(0)
    await addTraffic(first)
    first.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      for (const lineage of ["parked-b", "parked-a"]) {
        expect((await run(reopened, lineage, [], entries))._tag).toBe("Done")
      }
      expect(prefixEdits).toBe(2)
      expect(protectedEdits).toBe(2)
      const traffic = await Effect.runPromise(
        makeCollectionJournal({ store: reopened, lineageId: "later-traffic" }).read
      )
      expect(traffic).toHaveLength(1_006)
      expect(traffic[0]?._tag).toBe("ChainStarted")
    } finally {
      reopened.dispose?.()
    }
  }, 30_000)
})
