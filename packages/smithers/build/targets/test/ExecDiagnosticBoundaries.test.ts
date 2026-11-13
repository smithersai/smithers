import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Runtime from "../src/Runtime.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "exec-diagnostic-boundary-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})
const payload = (env: Readonly<Record<string, string>> = {}): Exec.Payload => ({
  cwd: ".",
  argv: [process.execPath, "-e", "process.stdout.write('ran')"],
  env,
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 5000
})

describe("exec diagnostics and environment boundaries", () => {
  it("drops a complete surrogate pair when the stderr tail would begin in its middle", async () => {
    const error = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, {
      ...payload(),
      argv: [
        process.execPath,
        "-e",
        `process.stderr.write("🙂" + "x".repeat(${Exec.stderrTailLimit - 1}), () => process.exit(1))`
      ]
    })))
    expect(error.code).toBe("exit_status")
    expect(error.stderr.length).toBe(Exec.stderrTailLimit - 1)
    expect(/^x+$/.test(error.stderr)).toBe(true)
    expect(error.stderr.isWellFormed()).toBe(true)
  })

  it("rechecks the aggregate environment bound after expanding a preload token", async () => {
    const token = `${Runtime.importTokenPrefix}./preload.mjs} `
    const maximum = 2 * 1024 * 1024
    const value = token + "x".repeat(maximum - Buffer.byteLength("NODE_OPTIONS") - Buffer.byteLength(token))
    const error = await Effect.runPromise(
      Effect.flip(Exec.run({ workspaceRoot: root }, payload({ NODE_OPTIONS: value })))
    )
    expect(error).toMatchObject({
      code: "invalid_payload",
      stdout: "",
      stderr: `exec environment exceeds ${maximum} bytes`
    })
  })

  it("deduplicates sensitive names before stripping them from the child", async () => {
    const result = await Effect.runPromise(Exec.run(
      { workspaceRoot: root, sensitiveEnv: ["BOUNDARY_TOKEN", "BOUNDARY_TOKEN"] },
      {
        ...payload({ BOUNDARY_TOKEN: "fixture-value" }),
        argv: [process.execPath, "-e", "process.stdout.write(String(process.env.BOUNDARY_TOKEN))"]
      }
    ))
    expect(result.stdout).toBe("undefined")
  })

  it("includes inherited PATH only when the host supplies it", () => {
    const names = ["PATH", "SMITHERS_BOUNDARY_GUARANTEED_ABSENT_7FE3B0"]
    const inherited = Exec.inheritedValues(names)
    expect(Object.hasOwn(inherited, "PATH")).toBe(process.env.PATH !== undefined)
    expect(Object.hasOwn(inherited, names[1]!)).toBe(false)
  })

  it("uses the host lookup environment when a Windows spawn shape omits env", () => {
    expect(Exec.spawnShape(["boundary-executable-without-extension"], { platform: "win32" })).toEqual({
      file: "boundary-executable-without-extension",
      args: [],
      windowsVerbatimArguments: false
    })
  })
})
