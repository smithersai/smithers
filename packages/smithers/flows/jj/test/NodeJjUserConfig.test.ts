import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/**
 * A user's jj config reaches every child NodeJj starts. A setting that
 * changes output formatting must not change what the layer parses.
 */
describe.skipIf(!jjInstalled)("NodeJj under a user config", () => {
  let directory: string
  let repository: string
  let previousConfig: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-node-jj-config-"))
    repository = join(directory, "repo")
    const config = join(directory, "config.toml")
    await writeFile(
      config,
      "[ui]\ncolor = \"always\"\n[user]\nname = \"Test\"\nemail = \"test@example.com\"\n"
    )
    previousConfig = process.env.JJ_CONFIG
    process.env.JJ_CONFIG = config
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
  })

  afterAll(async () => {
    if (previousConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = previousConfig
    await rm(directory, { recursive: true, force: true })
  })

  it.effect("returns clean change ids, diffs and roots with ui.color = always", () =>
    Effect.gen(function*() {
      const jj = yield* Effect.provide(Jj, NodeJj.layerAt(repository))
      yield* Effect.promise(() => writeFile(join(repository, "note.txt"), "first\n"))
      const { changeId } = yield* jj.snapshot("first")
      expect(changeId).toMatch(/^[a-z]+$/)
      yield* Effect.promise(() => writeFile(join(repository, "note.txt"), "second\n"))
      yield* jj.snapshot("second")
      const diff = yield* jj.diff(changeId, "@-")
      expect(diff).toContain("+second")
      expect(diff).not.toContain("\x1b[")
      expect(yield* jj.root!(repository)).not.toContain("\x1b[")
      yield* jj.restore(changeId)
    }).pipe(Effect.provideService(NodeJj.StartupTimeoutMs, 60_000)))
})
