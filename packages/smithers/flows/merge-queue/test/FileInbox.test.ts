import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Config } from "../src/index.ts"
import { Driver, empty, FileInbox, Inbox } from "../src/index.ts"
import { makeWorld } from "./support/World.ts"

const directory = mkdtempSync(join(tmpdir(), "merge-queue-inbox-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

let files = 0
const fresh = (): string => join(directory, `inbox-${files++}.jsonl`)

const withInbox = <A, E>(path: string, effect: Effect.Effect<A, E, Inbox | FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.provideMerge(FileInbox.layer({ path, poll: "5 millis" }), NodeFileSystem.layer))
    )
  )

const since = (path: string, cursor: number) => withInbox(path, Effect.flatMap(Inbox, (inbox) => inbox.since(cursor)))

describe("the inbox as a file", () => {
  it("is empty before anything was handed in", async () => {
    expect(await since(fresh(), 0)).toEqual([])
  })

  it("returns the letters after the cursor, in the order they were appended", async () => {
    const path = fresh()
    await withInbox(
      path,
      Effect.gen(function*() {
        yield* FileInbox.append(path, { _tag: "enqueue", id: 7, priority: 2 })
        yield* FileInbox.append(path, { _tag: "withdraw", id: 7 })
        yield* FileInbox.append(path, { _tag: "close" })
      })
    )
    expect(await since(path, 0)).toEqual([
      { _tag: "event", event: { _tag: "enqueue", id: 7, priority: 2 } },
      { _tag: "event", event: { _tag: "withdraw", id: 7 } },
      { _tag: "close" }
    ])
    expect(await since(path, 2)).toEqual([{ _tag: "close" }])
    expect(await since(path, 3)).toEqual([])
  })

  it("passes over a line that is not a letter and still counts it", async () => {
    const path = fresh()
    writeFileSync(
      path,
      "not json\n{\"_tag\":\"enqueue\",\"id\":-1,\"priority\":0}\n\n{\"_tag\":\"enqueue\",\"id\":1,\"priority\":0}\n"
    )
    expect(await since(path, 0)).toEqual([
      { _tag: "skip" },
      { _tag: "skip" },
      { _tag: "event", event: { _tag: "enqueue", id: 1, priority: 0 } }
    ])
    expect(FileInbox.letter("{}")).toBeUndefined()
  })

  it("an enqueue line that names a commit registers it before the queue takes the letter", async () => {
    const path = fresh()
    const seen: Array<string> = []
    const layer = Layer.provideMerge(
      FileInbox.layer({
        path,
        poll: "5 millis",
        register: (id, commit) => Effect.sync(() => void seen.push(`${id}=${commit}`))
      }),
      NodeFileSystem.layer
    )
    writeFileSync(
      path,
      "{\"_tag\":\"enqueue\",\"id\":4,\"priority\":1,\"commit\":\"abc\"}\n{\"_tag\":\"enqueue\",\"id\":5,\"priority\":0}\n"
    )
    const letters = await Effect.runPromise(
      Effect.flatMap(Inbox, (inbox) => inbox.since(0)).pipe(Effect.provide(layer))
    )
    expect(letters).toEqual([
      { _tag: "event", event: { _tag: "enqueue", id: 4, priority: 1 } },
      { _tag: "event", event: { _tag: "enqueue", id: 5, priority: 0 } }
    ])
    expect(seen).toEqual(["4=abc"])
  })

  it("wait returns once a line after the cursor exists", async () => {
    const path = fresh()
    let woke = false
    const waiting = withInbox(path, Effect.flatMap(Inbox, (inbox) => inbox.wait(0))).then(() => (woke = true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(woke).toBe(false)
    writeFileSync(path, "{\"_tag\":\"close\"}\n")
    await waiting
    expect(woke).toBe(true)
  })

  it("wait keeps polling while the file cannot be read, and returns once it can be", async () => {
    // A file system whose first two reads fail and which then works: nothing here depends on how long a read takes.
    const path = fresh()
    writeFileSync(path, JSON.stringify({ _tag: "close" }) + "\n")
    let reads = 0
    const recovering = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) => ({
        ...real,
        readFileString: (file: string, encoding?: string) =>
          reads++ < 2
            ? Effect.fail(
              PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "readFileString" })
            )
            : real.readFileString(file, encoding)
      }))
    ).pipe(Layer.provide(NodeFileSystem.layer))
    await Effect.runPromise(
      Effect.flatMap(Inbox, (inbox) => inbox.wait(0)).pipe(
        Effect.provide(Layer.provideMerge(FileInbox.layer({ path, poll: "5 millis" }), recovering))
      )
    )
    expect(reads).toBeGreaterThan(2)
  })

  it("reports the file system failing as the inbox being unavailable", async () => {
    const exit = await Effect.runPromiseExit(
      FileInbox.lines(directory).pipe(Effect.provide(NodeFileSystem.layer))
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Unavailable")
    const appended = await Effect.runPromiseExit(
      FileInbox.append(join(directory, "missing", "inbox.jsonl"), { _tag: "close" }).pipe(
        Effect.provide(NodeFileSystem.layer)
      )
    )
    expect(Exit.isFailure(appended)).toBe(true)
  })

  it("drives the queue: changes appended to the file land", async () => {
    const config: Config = { required: [1], maxAttempts: 1, maxBatch: 4, maxRuns: 4, window: 3, defaultDuration: 1 }
    const world = makeWorld(config)
    const path = fresh()
    const layer = Layer.merge(
      world.layer,
      Layer.provideMerge(FileInbox.layer({ path, poll: "5 millis" }), NodeFileSystem.layer)
    )
    writeFileSync(
      path,
      "{\"_tag\":\"enqueue\",\"id\":1,\"priority\":0}\ngarbage\n{\"_tag\":\"enqueue\",\"id\":2,\"priority\":0}\n{\"_tag\":\"close\"}\n"
    )
    let position: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [] }
    for (let rounds = 0; rounds < 50; rounds++) {
      const outcome = await Effect.runPromise(Driver.round(config, position).pipe(Effect.provide(layer)))
      position = outcome
      if (outcome.done) break
    }
    expect(position.cursor).toBe(4)
    expect(position.state.main.map((entry) => entry.id)).toEqual([1, 2])
  })
})
