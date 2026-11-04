import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect"
import { expect, test, vi } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { nodeDevice } from "../../test/chatApi"
import { close, FilesPage, open } from "./actions"
import { FilesStore } from "./store"

const at = { owner: "octocat", name: "Spoon-Knife", revision: "main" } as const

// Real browser persistence on a SQLite file. Hold the host's SQL to reproduce a
// busy engine worker, without replacing either the collection or its persistence.
test("file actions wait for the device write before navigating; reload restores exactly the remaining tabs", async () => {
  const device = nodeDevice()
  // One tab at a time: exercise SQLite persistence without cross-tab election.
  const host = { ...device.persistence!, coordinator: undefined }
  let release: (() => void) | undefined
  let blocked: Promise<void> | undefined
  let entered = false
  const persistence = Persistence.layer({
    ...host,
    open: async () => {
      const database = await host.open()
      return {
        ...database,
        execute: async <T>(sql: string, params?: ReadonlyArray<unknown>) => {
          if (blocked !== undefined) {
            entered = true
            await blocked
          }
          return database.execute<T>(sql, params)
        },
      }
    },
  })
  let here = { ...at, kind: "tree" as "tree" | "blob", path: "" }
  const navigated: Array<string> = []
  const layer = FilesStore.layer.pipe(Layer.provide(repoAuthority), Layer.provideMerge(persistence), Layer.provideMerge(Layer.succeed(FilesPage, {
    here: Effect.sync(() => Option.some(here)),
    navigate: (path) => { navigated.push(path) },
  })))
  const runtime = ManagedRuntime.make(layer)
  const hold = () => {
    entered = false
    blocked = new Promise<void>((resume) => { release = resume })
  }
  const resume = () => { blocked = undefined; release?.() }
  try {
    const store = await runtime.runPromise(Effect.service(FilesStore))
    await runtime.runPromise(store.tabs.restored)
    await runtime.runPromise(store.keep(at, "README.md", null))
    await vi.waitFor(() => expect(device.stored("file-tabs")).toBe(1))
    await runtime.runPromise(store.keep(at, "index.html", "2-4"))
    await vi.waitFor(() => expect(device.stored("file-tabs")).toBe(2))
    here = { ...at, kind: "blob", path: "README.md" }
    hold()
    const closing = runtime.runPromise(close("README.md"))
    await vi.waitFor(() => expect(entered).toBe(true))
    expect(device.stored("file-tabs")).toBe(2)
    expect(navigated).toEqual([])
    resume()
    expect(await closing).toMatchObject({ done: true })
    expect(device.stored("file-tabs")).toBe(1)
    expect(navigated.splice(0)).toEqual(["/octocat/Spoon-Knife/blob/main/index.html?L=2-4"])
    expect(await runtime.runPromise(store.drop(at, "README.md"))).toBe(false)
    // Both insertion and changing remembered lines must finish before navigation.
    for (const [path, lines] of [["extra.ts", "2"], ["index.html", "2"], ["index.html", "2-4"]] as const) {
      hold()
      const opening = runtime.runPromise(open(path, lines))
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(navigated).toEqual([])
      resume()
      await opening
      expect(navigated.splice(0)).toEqual([`/octocat/Spoon-Knife/blob/main/${path}?L=${lines}`])
    }
    expect(await runtime.runPromise(store.drop(at, "extra.ts"))).toBe(true)
  } finally {
    resume()
    await runtime.dispose()
  }
  const reloaded = ManagedRuntime.make(FilesStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.layer(host))))
  try {
    const store = await reloaded.runPromise(Effect.service(FilesStore))
    await reloaded.runPromise(store.tabs.restored)
    expect((await reloaded.runPromise(store.tabs.toArray)).map(({ path, lines, position }) => ({ path, lines, position })))
      .toEqual([{ path: "index.html", lines: "2-4", position: 2 }])
  } finally {
    await reloaded.dispose()
  }
})

test.each(["insert", "update", "delete"] as const)("a refused device %s never navigates or reports success", async (operation) => {
  const device = nodeDevice()
  const host = { ...device.persistence!, coordinator: undefined }
  let refuse = false
  const persistence = Persistence.layer({
    ...host,
    open: async () => {
      const database = await host.open()
      return {
        ...database,
        execute: <T>(sql: string, params?: ReadonlyArray<unknown>) => {
          if (refuse) {
            refuse = false
            return Promise.reject(new Error("device write refused"))
          }
          return database.execute<T>(sql, params)
        },
      }
    },
  })
  const navigated: Array<string> = []
  const runtime = ManagedRuntime.make(FilesStore.layer.pipe(
    Layer.provide(repoAuthority),
    Layer.provideMerge(persistence),
    Layer.provideMerge(Layer.succeed(FilesPage, {
      here: Effect.succeed(Option.some({ ...at, kind: "blob" as const, path: "README.md" })),
      navigate: (path) => { navigated.push(path) },
    })),
  ))
  try {
    const store = await runtime.runPromise(Effect.service(FilesStore))
    await runtime.runPromise(store.tabs.restored)
    await runtime.runPromise(store.keep(at, "README.md", null))
    refuse = true
    const action = operation === "delete" ? close("README.md") : open(operation === "insert" ? "index.html" : "README.md", "2-4")
    expect(Exit.isFailure(await runtime.runPromise(Effect.exit(action)))).toBe(true)
    expect(navigated).toEqual([])
    expect((await runtime.runPromise(store.tabs.toArray)).map(({ path, lines }) => [path, lines]))
      .toEqual([["README.md", null]])
    expect(device.stored("file-tabs")).toBe(1)
  } finally {
    await runtime.dispose()
  }
})
