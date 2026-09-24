import { describe, expect, it } from "@effect/vitest"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter, once } from "node:events"
import { createInterface } from "node:readline"
import { runInNewContext } from "node:vm"
import { Control } from "../src/internal/ProcessSupervisor.ts"
import { source } from "../src/internal/SupervisorProgram.ts"

const schedules = ["target exit", "status EOF", "request EOF"] as const

// Execute the shipped source with manual event/timer delivery. No OS signals
// occur here; recorded calls expose escalation before the grace timer runs.
const program = (killSignal: string, escaped = true, platform = "linux") => {
  const released: Array<number> = []
  const replacements: Array<readonly [string, string]> = []
  const signals: Array<readonly [number, string]> = []
  const timers: Array<{ run: () => void; millis: number }> = []
  const socket = () =>
    Object.assign(new EventEmitter(), {
      writable: true,
      destroyed: false,
      setEncoding: () => {},
      write: (_data: string, done: () => void) => done()
    })
  const status = socket()
  const requests = socket()
  const target = Object.assign(new EventEmitter(), { pid: 4102 })
  const runtime = Object.assign(new EventEmitter(), {
    pid: 4101,
    platform,
    env: {},
    argv: ["/fixture/s", "group"],
    kill: (pid: number, signal: string) => signals.push([pid, signal])
  })
  const modules: Record<string, unknown> = {
    "node:fs": {
      closeSync: (fd: number) => released.push(fd),
      openSync: (path: string, flags: string) => {
        replacements.push([path, flags])
        return replacements.length - 1
      }
    },
    "node:net": { connect: (path: string) => path.endsWith("/s") ? status : requests },
    "node:child_process": {
      spawn: () => target,
      spawnSync: () => ({
        status: 0,
        stdout: "4102 4101 4101 S Mon Sep 14 12:00:00 2026\n" +
          (escaped ? "4103 4102 4103 S Mon Sep 14 12:00:00 2026\n" : "")
      })
    }
  }
  runInNewContext(source, {
    require: (name: string) => modules[name],
    process: runtime,
    Buffer,
    setTimeout: (run: () => void, millis: number) => {
      const timer = { run, millis }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => {}
  })
  const send = (message: unknown) => requests.emit("data", JSON.stringify(message) + "\n")
  send({ type: "configure", command: "fixture", args: [], userFds: [], killSignal, graceMs: 25 })
  send({ type: "start" })
  return { signals, timers, status, requests, target, send, released, replacements }
}

describe("supervisor stop policy", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    it(`releases inherited pipes into the native null device on ${platform}`, () => {
      const helper = program("SIGTERM", false, platform)
      helper.target.emit("spawn")
      const device = platform === "win32" ? "NUL" : "/dev/null"
      expect(helper.released).toEqual([0, 1, 2])
      expect(helper.replacements).toEqual([[device, "r"], [device, "w"], [device, "w"]])
    })
  }

  for (const defaultSignal of ["SIGTERM", "SIGKILL"]) {
    for (const schedule of [...schedules, "status error", "request error", "repeated stop", "fast stop"] as const) {
      it(`preserves explicit TERM/5000 after ${schedule} with default ${defaultSignal}`, () => {
        const helper = program(defaultSignal)
        helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
        expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
        if (schedule === "target exit") helper.target.emit("exit", 0, null)
        else if (schedule === "status EOF") helper.status.emit("end")
        else if (schedule === "request EOF") helper.requests.emit("end")
        else if (schedule === "status error") helper.status.emit("error", new Error("closed"))
        else if (schedule === "request error") helper.requests.emit("error", new Error("closed"))
        else helper.send({ type: "stop", killSignal: "SIGKILL", fast: schedule === "fast stop" })
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
        expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
        helper.timers[0]!.run()
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"], [4103, "SIGKILL"]])
      })
    }
  }

  it("still permits the host's verified fast stop after natural target exit", () => {
    const helper = program("SIGTERM")
    helper.target.emit("exit", 0, null)
    expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
    helper.send({ type: "stop", killSignal: "SIGKILL", fast: true })
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
  })

  it("preserves an explicit stop even when no descendant escaped", () => {
    const helper = program("SIGKILL", false)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    helper.target.emit("exit", 0, null)
    helper.send({ type: "stop", killSignal: "SIGKILL", fast: true })
    expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
  })
})

describe.skipIf(process.platform === "win32")("real supervisor stop policy", () => {
  for (const schedule of schedules) {
    it(`preserves explicit grace after ${schedule} with a SIGKILL default`, async () => {
      const control = new Control()
      const token = randomUUID()
      // The escaped child keeps stdout open until it is actually killed. Its
      // TERM acknowledgement is the barrier before target exit or socket EOF.
      const descendant = `const token=${JSON.stringify(token)};
        process.on('SIGTERM',()=>process.stdout.write('term\\n'));
        process.send('ready');setInterval(()=>{},1000)`
      const leader = `process.on('SIGTERM',()=>{});
        const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],
          {detached:true,stdio:['ignore',1,2,'ipc']});
        child.once('message',()=>process.stdout.write(child.pid+'\\n'));
        process.stdin.once('data',()=>process.exit(0));`
      await control.listening
      const owner = spawn(process.execPath, ["-e", source, control.path, "group"], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      })
      const exited = once(owner, "exit")
      const drained = once(owner.stdout, "end")
      const lines = createInterface({ input: owner.stdout })[Symbol.asyncIterator]()
      let rejectFailure!: (error: Error) => void
      const failed = new Promise<never>((_, reject) => {
        rejectFailure = reject
      })
      // Fail inside the test's outer 30-second bound so finally still releases
      // the real fixture. A helper refusal must not become an opaque EOF hang.
      const deadline = setTimeout(() => rejectFailure(new Error("Real supervisor fixture exceeded 25 seconds")), 25_000)
      const checked = <A>(value: Promise<A>) => Promise.race([value, failed])
      let escapedPid: number | undefined
      try {
        expect(await checked(control.ready.promise)).toBe(owner.pid)
        control.socket!.on("data", () => {
          if (control.cleanupFailed) {
            rejectFailure(new Error(`Helper refused cleanup: ${JSON.stringify(control.fault)}`))
          }
        })
        await checked(control.requestsReady.promise)
        await checked(control.write({
          type: "configure",
          command: process.execPath,
          args: ["-e", leader],
          userFds: [],
          killSignal: "SIGKILL",
          graceMs: 25
        }))
        control.activationSent = true
        await checked(control.write({ type: "start" }))
        await checked(control.started.promise)
        const ready = await checked(lines.next())
        expect(ready.done).toBe(false)
        escapedPid = Number(ready.value)
        expect(Number.isSafeInteger(escapedPid) && escapedPid > 1).toBe(true)
        const graceMs = 1000
        const stoppingAt = performance.now()
        await checked(control.write({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs }))
        expect(await checked(lines.next())).toMatchObject({ value: "term", done: false })
        if (schedule === "target exit") {
          owner.stdin.end("exit\n")
          expect(await checked(control.exited.promise)).toBe(0)
        } else if (schedule === "status EOF") control.socket!.end()
        else control.requestSocket!.end()
        // No test sleep: inherited stdout EOF proves all its writers exited.
        await checked(drained)
        const elapsed = performance.now() - stoppingAt
        expect(await checked(exited)).toEqual([null, "SIGKILL"])
        expect(elapsed).toBeGreaterThanOrEqual(graceMs)
        await checked(control.ended.promise)
        if (schedule !== "status EOF") {
          expect(control.cleanupAcknowledged).toBe(true)
          expect(control.cleanupFailed).toBe(false)
        }
        const observed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(escapedPid)], { encoding: "utf8" })
        expect(observed.status !== 0 || observed.stdout.trim().startsWith("Z"), observed.stdout).toBe(true)
      } finally {
        clearTimeout(deadline)
        control.dispose()
        // The native child handle and UUID-validated fixture PIDs remain ours
        // even when a failed observation prevented the helper's own sweep.
        owner.kill("SIGKILL")
        for (const pid of [control.targetPid, escapedPid]) {
          if (pid === undefined) continue
          const identity = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
            encoding: "utf8"
          })
          if (identity.stdout.includes(token)) process.kill(pid, "SIGKILL")
        }
        await exited
      }
    })
  }
})
