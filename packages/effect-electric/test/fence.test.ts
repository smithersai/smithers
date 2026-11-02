import { describe, expect, test } from "vitest"
import { fenced, type SyncControls } from "../src/internal/fence.ts"

// The controls an Electric collection's sync writes through: open, every call reaches TanStack DB's; closed by
// `evict`, none does. Here TanStack DB's side is a record of the calls that reached it.

const controls = () => {
  const calls: Array<string> = []
  const side = (name: string) => ({
    get: (key: string | number) => `${name}:${key}`,
    set: (key: string | number, value: unknown) => void calls.push(`${name}.set ${key}=${String(value)}`),
    delete: (key: string | number) => void calls.push(`${name}.delete ${key}`)
  })
  const base = {
    begin: () => void calls.push("begin"),
    write: (message: { readonly key: string }) => void calls.push(`write ${message.key}`),
    commit: () => (calls.push("commit"), "receipt"),
    truncate: () => void calls.push("truncate"),
    markReady: () => void calls.push("markReady"),
    collection: "the collection",
    metadata: { persistence: null, row: side("row"), collection: side("collection") }
  }
  return { calls, base }
}

const drive = (sync: SyncControls) => {
  sync.begin()
  sync.write({ key: "a" } as never)
  sync.metadata?.row?.set("a", "tags")
  sync.metadata?.row?.delete("a")
  sync.metadata?.collection.set("electric:resume", "resume")
  sync.metadata?.collection.delete("electric:resume")
  sync.truncate()
  return sync.commit()
}

describe("fenced", () => {
  test("open, every write reaches TanStack DB's controls, and reads and readiness pass through", () => {
    const { calls, base } = controls()
    const sync = fenced(base, () => true)
    expect(drive(sync)).toBe("receipt")
    sync.markReady()
    expect(calls).toEqual([
      "begin",
      "write a",
      "row.set a=tags",
      "row.delete a",
      "collection.set electric:resume=resume",
      "collection.delete electric:resume",
      "truncate",
      "commit",
      "markReady"
    ])
    expect([sync.collection, sync.metadata.collection.get("k"), sync.metadata.row.get("k")]).toEqual([
      "the collection",
      "collection:k",
      "row:k"
    ])
  })

  test("closed, nothing it writes reaches them, and its commit reads as applied", () => {
    const { calls, base } = controls()
    let open = true
    const sync = fenced(base, () => open)
    open = false
    expect(drive(sync)).toBe(true)
    expect(calls).toEqual([])
  })

  test("controls with no metadata, or no row metadata, stay so", () => {
    const { base } = controls()
    const { metadata: _metadata, ...bare } = base
    expect(fenced(bare, () => true)).not.toHaveProperty("metadata")
    const noRow = fenced({ ...bare, metadata: { collection: base.metadata.collection } }, () => true)
    expect(noRow.metadata).not.toHaveProperty("row")
  })
})
