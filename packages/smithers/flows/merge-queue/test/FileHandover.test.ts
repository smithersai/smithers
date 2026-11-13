import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { FileHandover, Handover } from "../src/index.ts"

const directory = mkdtempSync(join(tmpdir(), "merge-queue-handover-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

let files = 0
const fresh = (): string => join(directory, `position-${files++}.json`)

const on = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

describe("the hand-over as a file", () => {
  it("holds nothing before a lineage has ended", async () => {
    expect(await on(FileHandover.read(fresh()))).toBeUndefined()
  })

  it("holds the last position saved, whole, and leaves no other file behind", async () => {
    const path = fresh()
    await on(FileHandover.save(path, { done: false, position: { round: 0, cursor: 7 } }))
    expect(await on(FileHandover.read(path))).toEqual({ done: false, position: { round: 0, cursor: 7 } })
    await on(FileHandover.save(path, { done: true, position: { round: 0, cursor: 9 } }))
    await on(FileHandover.save(path, { done: true, position: { round: 0, cursor: 9 } }))
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ done: true, position: { round: 0, cursor: 9 } })
    expect(readdirSync(directory).filter((name) => name.startsWith(path.split("/").at(-1)!))).toHaveLength(1)
  })

  it("is unavailable when the file cannot be written, or holds something that is not a hand-over", async () => {
    const folder = join(directory, `folder-${files++}`)
    mkdirSync(folder)
    const broken = fresh()
    writeFileSync(broken, "{\"done\":\"perhaps\"}")
    for (
      const failure of [
        await on(
          Effect.flip(FileHandover.save(join(folder, "missing", "position.json"), { done: false, position: {} }))
        ),
        await on(Effect.flip(FileHandover.save(folder, { done: false, position: {} }))),
        await on(Effect.flip(FileHandover.read(folder))),
        await on(Effect.flip(FileHandover.read(broken)))
      ]
    ) {
      expect(failure).toMatchObject({ _tag: "@smthrs/merge-queue/Unavailable", service: "handover" })
      expect(failure.detail).not.toBe("")
    }
  })

  it("is the Handover service of a host", async () => {
    const path = fresh()
    await Effect.runPromise(
      Effect.flatMap(Handover, (handover) => handover.save({ done: false, position: { lineage: 200 } })).pipe(
        Effect.provide(Layer.provideMerge(FileHandover.layer({ path }), NodeFileSystem.layer))
      )
    )
    expect(await on(FileHandover.read(path))).toEqual({ done: false, position: { lineage: 200 } })
  })
})
