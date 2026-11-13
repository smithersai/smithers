import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Input from "../src/Input.ts"
import { GeneratorScanLimits } from "../src/internal/GeneratorScanLimits.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "generator-scan-limits-")))
  await Fs.mkdir(Path.join(root, "out"))
  await Fs.writeFile(Path.join(root, "out/original"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const payload = (script: string, changes = ["out"]): Compose.GenerateCheckPayload => ({
  run: {
    cwd: ".",
    argv: [process.execPath, "-e", script],
    env: {},
    secrets: [],
    expectedExitCodes: [0],
    timeoutMs: 5000
  },
  changes
})

describe("generator output scan budgets", () => {
  it.each(["depth", "directories", "entries", "files"] as const)(
    "refuses an exhausted %s budget before executing the generator",
    async (kind) => {
      const limits = { ...Input.defaultScanLimits, [kind]: 0 }
      const error = await Effect.runPromise(Effect.flip(
        Compose.checkGenerator(
          { workspaceRoot: root },
          payload("require('node:fs').writeFileSync('ran', 'unexpected')")
        ).pipe(Effect.provideService(GeneratorScanLimits, limits))
      ))
      expect(error).toMatchObject({
        _tag: "smithers-build/DriftError",
        message: `declared output scan exceeds its ${kind} limit of 0`
      })
      await expect(Fs.stat(Path.join(root, "ran"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await Fs.readFile(Path.join(root, "out/original"), "utf8")).toBe("original")
    }
  )

  it("counts duplicate output directories once against the directory budget", async () => {
    await Effect.runPromise(
      Compose.checkGenerator({ workspaceRoot: root }, payload("", ["out", "out"]))
        .pipe(Effect.provideService(GeneratorScanLimits, { ...Input.defaultScanLimits, directories: 1 }))
    )
    expect(await Fs.readFile(Path.join(root, "out/original"), "utf8")).toBe("original")
  })
})
