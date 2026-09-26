/**
 * Confined wiki reads and atomic generated writes when the filesystem itself
 * fails: every step reports a value-free refusal naming what failed.
 */
import { Effect } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Confined from "../src/internal/confined.ts"
import { faultyLayer, run, tempDir } from "./support.ts"

const failWith = <A>(
  effect: Effect.Effect<A, Confined.Refusal, FileSystem.FileSystem | Path.Path>,
  fault: (method: string, path: string) => boolean
) => Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(faultyLayer(fault))))

describe("confined writes", () => {
  it("writes atomically, creating directories, and refuses malformed paths", async () => {
    const root = tempDir()
    const target = await run(Confined.writeText({ root, relative: "Org/Runs/a/b.json", content: "{}\n" }))
    expect(target).toBe(join(root, "Org", "Runs", "a", "b.json"))
    const refused = await Effect.runPromise(
      Effect.flip(Confined.writeText({ root, relative: "Org/Runs/", content: "" })).pipe(
        Effect.provide(faultyLayer(() => false))
      )
    )
    expect(refused).toMatchObject({ code: "invalid-path" })
  })

  it("names the filesystem step that failed", async () => {
    const root = tempDir()
    const write = Confined.writeText({ root, relative: "Org/Runs/b.json", content: "{}" })
    expect((await failWith(write, (method, path) => method === "exists" && path.endsWith("Org"))).message).toBe(
      "could not be checked"
    )
    expect((await failWith(write, (method) => method === "makeDirectory")).message).toBe(
      "a directory could not be created"
    )
    expect((await failWith(write, (method, path) => method === "realPath" && path.endsWith("Org"))).message).toBe(
      "could not be resolved"
    )
    expect((await failWith(write, (method) => method === "writeFileString")).message).toBe("could not be written")
  })
})

describe("confined reads", () => {
  it("names the filesystem step that failed", async () => {
    const root = tempDir()
    mkdirSync(join(root, "Org"))
    writeFileSync(join(root, "Org", "a.md"), "text")
    const read = Confined.readText({ root, relative: "Org/a.md", maxBytes: 100, admit: () => true })
    expect(await run(read)).toBe("text")
    expect((await failWith(read, (method, path) => method === "stat" && path.endsWith("a.md"))).message).toBe(
      "could not be read"
    )
    expect((await failWith(read, (method) => method === "readFileString")).message).toBe("could not be read")
    expect((await failWith(read, (method, path) => method === "realPath" && !path.endsWith("a.md"))).message).toBe(
      "the wiki root could not be resolved"
    )
  })
})
