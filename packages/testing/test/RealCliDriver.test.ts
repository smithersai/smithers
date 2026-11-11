import { NodeHost } from "@smthrs/platform-node"
import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "vitest"
import * as ProcessTable from "../src/ProcessTable.ts"
import * as Driver from "../src/RealCliDriver.vibe"

const run = <A, E>(effect: Effect.Effect<A, E, NodeHost.NodeHost>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeHost.layer)))
const node = (source: string, options: Partial<Driver.Options> = {}) =>
  Driver.make({ executable: process.execPath, args: ["-e", source], ...options })

describe("isolated real CLI driver", () => {
  it("supports an executable with no arguments, input or ambient environment", async () => {
    expect(await run(Driver.execute({ executable: process.execPath, cwd: "/tmp" })))
      .toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("uses fresh home and XDG state and removes it after the scope", async () => {
    const root = await run(Effect.scoped(Effect.gen(function*() {
      const first = yield* node("console.log(process.env.HOME); console.error('diagnostic'); process.exitCode=7")
      const second = yield* node("console.log(process.env.HOME)")
      expect(first.root).not.toBe(second.root)
      const result = yield* first.run([])
      expect(result).toEqual({ code: 7, stdout: `${first.home}\n`, stderr: "diagnostic\n" })
      expect(yield* (yield* FileSystem.FileSystem).exists(first.cwd)).toBe(true)
      return first.root
    })))
    expect(
      await run(Effect.gen(function*() {
        return yield* (yield* FileSystem.FileSystem).exists(root)
      }))
    ).toBe(false)
  })

  it("passes literal argv and an explicit environment without inheriting credentials", async () => {
    const value = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node("console.log(JSON.stringify({args:process.argv.slice(1),env:process.env}))", {
        env: { PATH: process.env.PATH ?? "", FIXTURE: "kept", HOME: "/ignored" }
      })
      return { driver, result: yield* driver.run(["a b", "$(false)", "'quoted'"]) }
    })))
    const output = JSON.parse(value.result.stdout)
    expect(output.args).toEqual(["a b", "$(false)", "'quoted'"])
    expect(output.env.HOME).toBe(value.driver.home)
    expect(output.env.FIXTURE).toBe("kept")
    expect(output.env.SMITHERS_AUTH_FILE).toBe(`${value.driver.home}/auth.json`)
    expect(output.env.SMITHERS_DISABLE_SYSTEM_KEYRING).toBe("1")
    expect(output.env).not.toHaveProperty("SMITHERS_TOKEN")
    expect(output.env.XDG_CONFIG_HOME).toBe(`${value.driver.home}/config`)
  })

  it("pipes input literally without putting it in argv", async () => {
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node(
        "let text=''; process.stdin.on('data', b=>text+=b); process.stdin.on('end',()=>console.log(JSON.stringify({text,args:process.argv.slice(1)})))"
      )
      return yield* driver.run([], "input from a pipe\n")
    })))
    expect(JSON.parse(result.stdout)).toEqual({ text: "input from a pipe\n", args: [] })
    expect(result.code).toBe(0)
  })

  it("reaps the owned process group on timeout, including a real descendant", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node(
        "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(process.env.HOME+'/pids.json', JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)",
        { timeoutMs: 1000 }
      )
      expect(yield* driver.run([]).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "timeout" }
      })
      const fs = yield* FileSystem.FileSystem
      const pids = JSON.parse(yield* fs.readFileString(`${driver.home}/pids.json`)) as Array<number>
      expect(pids).toHaveLength(2)
      for (const pid of pids) {
        const state = ProcessTable.query({ pid, columns: ["stat"], timeoutMs: 2000 }).trim()
        expect(state === "" || state.startsWith("Z"), `owned process ${pid} remains live: ${state}`).toBe(true)
      }
    })))
  })

  it("drains both pipes concurrently and decodes split UTF-8", async () => {
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node(
        "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000)); const b=Buffer.from('😀'); process.stdout.write(b.subarray(0,2)); setImmediate(()=>process.stdout.write(b.subarray(2)))"
      )
      return yield* driver.run([])
    })))
    expect(result).toEqual({ code: 0, stdout: "x".repeat(100000) + "😀", stderr: "y".repeat(100000) })
  })

  it("bounds a stalled command and closes its process scope", async () => {
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node("setInterval(()=>{},1000)", { timeoutMs: 200 })
      return yield* driver.run([]).pipe(Effect.result)
    })))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DriverError", reason: "timeout" } })
  })

  it("fails when combined output exceeds its byte budget", async () => {
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* node("process.stdout.write('😀'.repeat(20)); process.stderr.write('b'.repeat(40))", {
        maxBytes: 100
      })
      return yield* driver.run([]).pipe(Effect.result)
    })))
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "output-limit" } })
  })

  it.each([{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxBytes: -1 }, { maxBytes: 1.5 }])(
    "rejects an invalid process bound %j",
    async (options) => {
      const result = await run(Effect.scoped(node("", options).pipe(Effect.result)))
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-options" } })
    }
  )

  it("reports a missing executable as a platform failure", async () => {
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const driver = yield* Driver.make({ executable: "/missing/sm-b27" })
      return yield* driver.run([]).pipe(Effect.result)
    })))
    expect(result._tag).toBe("Failure")
  })
})
