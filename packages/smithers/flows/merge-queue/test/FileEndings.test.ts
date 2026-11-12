import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Ending } from "../src/index.ts"
import { Endings, FileEndings } from "../src/index.ts"

const directory = mkdtempSync(join(tmpdir(), "merge-queue-endings-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

let files = 0
const fresh = (): string => join(directory, `endings-${files++}.jsonl`)

const on = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))

const merged = (id: number): Ending => ({
  id,
  rev: 0,
  attempts: 0,
  status: { _tag: "merged" },
  landing: { run: id, results: [{ check: 1, verdict: "pass" }], foreign: false }
})

const unmergeable: Ending = {
  id: 9,
  rev: 2,
  attempts: 2,
  status: {
    _tag: "unmergeable",
    reason: { kind: "agentVerdict", detail: "written against the old parser;\nredo it", failures: [1, 2], attempts: 2 }
  },
  landing: null
}

const withdrawn: Ending = { id: 4, rev: 1, attempts: 1, status: { _tag: "withdrawn" }, landing: null }

const strip = (lines: ReadonlyArray<typeof FileEndings.Line.Type>): ReadonlyArray<Ending> =>
  lines.map(({ at: _at, ...ending }) => ending)

describe("the record of endings as a file", () => {
  it("is empty before any change ended", async () => {
    expect(await on(FileEndings.read(fresh()))).toEqual([])
  })

  it("holds each ending on one line, with the reason word for word and the time it was recorded", async () => {
    const path = fresh()
    const before = Date.now()
    await on(FileEndings.record(path, [merged(1), unmergeable]))
    await on(FileEndings.record(path, [withdrawn]))
    const lines = await on(FileEndings.read(path))
    expect(strip(lines)).toEqual([merged(1), unmergeable, withdrawn])
    expect(lines.every((line) => line.at >= before && line.at <= Date.now())).toBe(true)
    expect(readFileSync(path, "utf8").split("\n").length).toBe(4)
  })

  it("records a change once: again, twice in one call, or with a different ending later", async () => {
    const path = fresh()
    await on(FileEndings.record(path, [merged(1)]))
    const first = readFileSync(path, "utf8")
    await on(FileEndings.record(path, [merged(1)]))
    await on(FileEndings.record(path, [{ ...withdrawn, id: 1 }]))
    await on(FileEndings.record(path, []))
    expect(readFileSync(path, "utf8")).toBe(first)
    await on(FileEndings.record(path, [merged(2), { ...withdrawn, id: 2 }, merged(1)]))
    expect(strip(await on(FileEndings.read(path)))).toEqual([merged(1), merged(2)])
  })

  it("passes over a line a crash cut short and starts the next ending on a line of its own", async () => {
    const path = fresh()
    await on(FileEndings.record(path, [merged(1)]))
    const whole = readFileSync(path, "utf8")
    writeFileSync(path, whole + JSON.stringify({ ...merged(2), at: 1 }).slice(0, 25))
    expect(strip(await on(FileEndings.read(path)))).toEqual([merged(1)])
    // Change 2 is not held: its line never finished.
    await on(FileEndings.record(path, [merged(2), merged(3)]))
    expect(strip(await on(FileEndings.read(path)))).toEqual([merged(1), merged(2), merged(3)])
    expect(readFileSync(path, "utf8").split("\n").length).toBe(5)
  })

  it("is unavailable when the file cannot be read or written, and names the record", async () => {
    const folder = join(directory, `folder-${files++}`)
    mkdirSync(folder)
    for (
      const failure of [
        await on(Effect.flip(FileEndings.read(folder))),
        await on(Effect.flip(FileEndings.record(folder, [merged(1)]))),
        await on(Effect.flip(FileEndings.record(join(folder, "missing", "endings.jsonl"), [merged(1)])))
      ]
    ) {
      expect(failure).toMatchObject({ _tag: "@smthrs/merge-queue/Unavailable", service: "endings" })
      expect(failure.detail).not.toBe("")
    }
  })

  it("is the Endings service of a host", async () => {
    const path = fresh()
    await Effect.runPromise(
      Effect.flatMap(Endings, (endings) => endings.record([merged(5), withdrawn])).pipe(
        Effect.provide(Layer.provideMerge(FileEndings.layer({ path }), NodeFileSystem.layer))
      )
    )
    expect(strip(await on(FileEndings.read(path)))).toEqual([merged(5), withdrawn])
  })
})
