import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPtyManager } from "./Pty"
import { PtySpawnError, spawnPty } from "./PtySpawn"

let root = ""
const children: Array<ReturnType<typeof Bun.spawn>> = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "smithers-pty-spawn-")) })
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    child.terminal?.close()
  }))
  await rm(root, { recursive: true, force: true })
})

const launch = (argv: ReadonlyArray<string>) => {
  let output = ""
  const eof = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const decoder = new TextDecoder()
  const child = spawnPty(argv, {
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    terminal: {
      cols: 80, rows: 24,
      data: (_terminal, chunk) => {
        output += decoder.decode(chunk, { stream: true })
        if (output.includes("READY\r\n") || output.includes("READY\n")) ready.resolve()
      },
      exit: () => { output += decoder.decode(); eof.resolve() }
    }
  })
  children.push(child)
  return { child, eof: eof.promise, ready: ready.promise, output: () => output.replaceAll("\r", "") }
}

describe("PTY spawn admission", () => {
  test("preserves the target PID, literal argv, terminal input and resize without exposing the gate", async () => {
    const argument = 'two  spaces "quote" $literal ; $(not-executed) 界'
    const input = "typed é 界 😀 with spaces"
    const { child, eof, ready, output } = launch([
      "/bin/sh", "-c",
      'test -t 0 && test -t 1 && test -t 2 || exit 31; test ! -e /dev/fd/3 || exit 32; stty -echo; printf "READY\\n"; IFS= read -r typed; printf "pid:%s\\narg:%s\\ninput:%s\\n" "$$" "$1" "$typed"; stty size',
      "original-command", argument
    ])
    await ready
    expect(child.stdin).toBeNull()
    expect(child.stdout).toBeNull()
    expect(child.stderr).toBeNull()
    child.terminal!.resize(96, 37)
    child.terminal!.write(input + "\n")
    expect(await child.exited).toBe(0)
    await eof
    expect(output()).toBe(`READY\npid:${child.pid}\narg:${argument}\ninput:${input}\n37 96\n`)
    if (process.platform === "darwin") expect(() => fs.fstatSync(child.stdio[3]!)).toThrow()
  })

  test("drains Unicode from rapidly exiting commands and preserves nonzero exit status", async () => {
    for (const argv of [["/usr/bin/printf", "%s", "start-é-界-😀"], ["/bin/sh", "-c", "exit 17"]]) {
      const { child, eof, output } = launch(argv)
      expect(await child.exited).toBe(argv[0] === "/usr/bin/printf" ? 0 : 17)
      await eof
      expect(output()).toBe(argv[0] === "/usr/bin/printf" ? "start-é-界-😀" : "")
    }
  })

  test("keeps the Linux path free of a control descriptor", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    let launched: ReturnType<typeof launch>
    try {
      Object.defineProperty(process, "platform", { value: "linux" })
      // This child waits for PTY input, so it also safely exercises the raw
      // platform branch when macOS's kqueue delay is injected into this test.
      launched = launch(["/bin/sh", "-c", 'IFS= read -r line; printf "%s" "$line"'])
    } finally { Object.defineProperty(process, "platform", platform) }
    expect(launched.child.stdio[3]).toBeUndefined()
    launched.child.terminal!.write("linux-path\n")
    expect(await launched.child.exited).toBe(0)
    await launched.eof
    expect(launched.output()).toContain("linux-path")
  })

  test.skipIf(process.platform !== "darwin")("refuses a missing executable before acquiring a child", () => {
    expect(() => launch([join(root, "missing")])).toThrow("Terminal executable was not found")
  })

  test.skipIf(process.platform !== "darwin")("a terminal-close error after reaping still returns the manager's spawn_failed refusal", async () => {
    const owner = createPtyManager({
      home: root, env: {}, publish: () => {}, log: () => {},
      sandboxHost: { platform: "linux", disabled: true, log: () => {} },
      harnesses: async () => [{
        id: "pi", displayName: "fixture", binary: "/usr/bin/printf", version: null,
        status: "binary-only", account: null, launch: { argv: ["printf", "%s", "MUST-NOT-RUN"] }
      }]
    })
    const originalSpawn = Bun.spawn
    let spawned: ReturnType<typeof Bun.spawn> | undefined
    let restoreClose = () => {}
    let closeCalls = 0
    const spawn = spyOn(Bun, "spawn").mockImplementation(((...args: Array<unknown>) => {
      spawned = Reflect.apply(originalSpawn, Bun, args)
      const terminal = spawned!.terminal!
      const originalClose = terminal.close.bind(terminal)
      const close = spyOn(terminal, "close").mockImplementation(() => {
        closeCalls += 1
        originalClose()
        throw new Error("terminal already closed")
      })
      restoreClose = () => close.mockRestore()
      return spawned!
    }) as typeof Bun.spawn)
    const write = spyOn(fs, "writeSync").mockImplementationOnce(() => { throw new Error("injected gate write failure") })
    try {
      expect(await owner.create({ kind: "harness", harnessId: "pi", cwd: root, cols: 80, rows: 24 })).toMatchObject({
        status: "error", code: "spawn_failed", message: expect.stringContaining("injected gate write failure")
      })
      expect(spawned?.signalCode).toBe("SIGKILL")
      expect(closeCalls).toBe(1)
      expect(owner.list()).toEqual([])
    } finally {
      write.mockRestore()
      spawn.mockRestore()
      restoreClose()
      await owner.dispose()
    }
  })

  for (const failure of ["write", "short-write", "close"] as const) {
    test.skipIf(process.platform !== "darwin")(`a ${failure} failure closes the gate and reaps only its newly created child`, async () => {
      const survivor = launch(["/bin/sh", "-c", 'printf "READY\\n"; IFS= read -r line; printf "%s" "$line"'])
      await survivor.ready
      const marker = join(root, "must-not-run")
      const originalWrite = fs.writeSync
      const originalClose = fs.closeSync
      let failedFd: number | undefined
      let intercepted = false
      const write = spyOn(fs, "writeSync").mockImplementation(((fd: number, ...args: Array<unknown>) => {
        if (!intercepted && failure !== "close") {
          intercepted = true
          failedFd = fd
          if (failure === "short-write") return 0
          throw new Error("injected gate write failure")
        }
        return Reflect.apply(originalWrite, fs, [fd, ...args])
      }) as typeof fs.writeSync)
      const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
        if (!intercepted && failure === "close") {
          intercepted = true
          failedFd = fd
          throw new Error("injected gate close failure")
        }
        originalClose(fd)
      })
      let rejected: unknown
      try { launch(["/bin/sh", "-c", 'printf ran > "$1"', "command", marker]) }
      catch (error) { rejected = error }
      finally { write.mockRestore(); close.mockRestore() }
      expect(rejected).toBeInstanceOf(PtySpawnError)
      await (rejected as PtySpawnError).stopped
      expect(intercepted).toBe(true)
      expect(() => fs.fstatSync(failedFd!)).toThrow()
      expect(fs.existsSync(marker)).toBe(false)
      expect(survivor.child.exitCode).toBeNull()
      survivor.child.terminal!.write("still-alive\n")
      expect(await survivor.child.exited).toBe(0)
      await survivor.eof
      expect(survivor.output()).toContain("still-alive")
    })
  }
})
