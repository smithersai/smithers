import { describe, expect, test } from "bun:test"
import { captureBrowserStorageRecovery, createRecoveryDownload, recoveryStorage } from "./BrowserStorageRecovery"

const memory = (entries: ReadonlyArray<readonly [string, string]>) => {
  const bytes = new Map(entries)
  return {
    bytes,
    get length() {
      return bytes.size
    },
    key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null
  }
}

describe("a browser recovery artifact identifies its separate sources", () => {
  test("retains ambiguous persisted histories and a memory session separately without interpreting any stamp", async () => {
    const localStorage = memory([["smithers-mvp.persistenceBackend", "unknown"], [
      "smithers-mvp.old",
      "older private original"
    ]])
    const transient = memory([["smithers-mvp.store", "temporary session"]])
    const sqlite = [{
      name: "raw",
      sql: null,
      columns: ["value"],
      rows: [[{ type: "text" as const, value: "newer private original" }]]
    }]
    const snapshot = await captureBrowserStorageRecovery({
      session: "memory",
      localStorage,
      sqlite: async () => sqlite,
      memory: transient
    })
    expect(snapshot.session).toBe("memory")
    expect(snapshot.unavailable).toEqual([])
    expect(snapshot.localStorage).toContainEqual({ key: "smithers-mvp.old", value: "older private original" })
    expect(snapshot.sqlite).toEqual(sqlite)
    expect(snapshot.memory).toEqual([{ key: "smithers-mvp.store", value: "temporary session" }])
    expect([...localStorage.bytes]).toEqual([["smithers-mvp.persistenceBackend", "unknown"], [
      "smithers-mvp.old",
      "older private original"
    ]])
  })

  test("unavailable APIs are explicit, not confused with an absent database", async () => {
    const unavailable = await captureBrowserStorageRecovery({
      session: "unopened",
      localStorage: undefined,
      sqlite: undefined
    })
    expect(unavailable.unavailable).toEqual(["localStorage", "sqlite"])
    expect(unavailable.sqlite).toBeUndefined()
    const absent = await captureBrowserStorageRecovery({
      session: "localStorage",
      localStorage: memory([]),
      sqlite: async () => undefined
    })
    expect(absent.unavailable).toEqual([])
    expect(absent.localStorage).toEqual([])
    expect(absent.sqlite).toBeUndefined()
  })

  test("a local edit during the SQLite read refuses a mixed capture", async () => {
    const localStorage = memory([["smithers-mvp.store", "before"]])
    await expect(captureBrowserStorageRecovery({
      session: "unopened",
      localStorage,
      sqlite: async () => {
        localStorage.bytes.set("smithers-mvp.store", "after")
        return []
      }
    })).rejects.toThrow("changed")
    expect(localStorage.getItem("smithers-mvp.store")).toBe("after")
  })

  test("unreadable SQLite refuses the artifact rather than silently exporting only localStorage", async () => {
    await expect(captureBrowserStorageRecovery({
      session: "unopened",
      localStorage: memory([]),
      sqlite: async () => {
        throw new Error("fixture unavailable")
      }
    })).rejects.toThrow("fixture unavailable")
  })

  test("a non-enumerable injected storage is refused instead of dropping historical keys", () => {
    expect(recoveryStorage(undefined)).toBeUndefined()
    expect(() => recoveryStorage({ getItem: () => "private" })).toThrow("could not be read completely")
  })
})

describe("the private local Blob handoff", () => {
  for (const failure of [undefined, "element", "click"] as const) {
    test(`owns every object URL and anchor (failure: ${failure ?? "none"})`, async () => {
      const revoked: string[] = []
      const blobs: Blob[] = []
      let removed = 0
      let clicks = 0
      const anchor = {
        href: "",
        download: "",
        hidden: false,
        click: () => {
          clicks++
          if (failure === "click") throw new Error("fixture click refused")
        },
        remove: () => {
          removed++
        }
      }
      const host = {
        createElement: () => {
          if (failure === "element") throw new Error("fixture element refused")
          return anchor
        },
        body: { append: () => {} }
      } as unknown as Document
      const urls = {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return "blob:fixture"
        },
        revokeObjectURL: (url: string) => {
          revoked.push(url)
        }
      } as unknown as typeof URL
      const handoff = createRecoveryDownload(host, urls)
      try {
        if (failure === undefined) {
          handoff.download("private file")
          expect(await blobs[0]?.text()).toBe("private file")
          expect(anchor.download).toBe("smithers-local-recovery.json")
          expect(anchor.href).toBe("blob:fixture")
          expect(clicks).toBe(1)
          expect(removed).toBe(1)
          expect(revoked).toEqual([])
        } else {
          expect(() => handoff.download("private file")).toThrow("fixture")
          expect(revoked.length).toBe(blobs.length)
        }
      } finally {
        handoff.dispose()
      }
      expect(revoked.length).toBe(blobs.length)
      handoff.dispose()
      expect(revoked.length).toBe(blobs.length)
      expect(() => handoff.download("later")).toThrow("could not be read completely")
    })
  }
})
