import { describe, expect, it } from "@effect/vitest"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Effect, Exit } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunHost from "../src/BunHost.ts"

const identity = (pid: number) => {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }
    }).trim()
  } catch {
    return "gone"
  }
}
const readBeat = (path: string): { token: string; pid: number; tick: number } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

describe.skipIf(process.platform === "win32")("leader exit containment", () => {
  it.live("contains a child first spawned after the leader's initial snapshot when its leader exits naturally", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "flows-natural-leader-"))
      const token = randomUUID()
      const heartbeat = join(directory, "heartbeat.json")
      const trigger = join(directory, "spawn-child")
      const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
        JSON.stringify(heartbeat)
      };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,25)`
      const leader =
        `const fs=require('node:fs');const{spawn}=require('node:child_process');const timer=setInterval(()=>{if(!fs.existsSync(${
          JSON.stringify(trigger)
        }))return;clearInterval(timer);spawn(process.execPath,['-e',${
          JSON.stringify(child)
        }],{stdio:'ignore'}).unref();const ready=setInterval(()=>{if(fs.existsSync(${
          JSON.stringify(heartbeat)
        })){clearInterval(ready);process.exit(0)}},5)},5)`
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "natural-leader", ownerPid: process.pid })
      try {
        const close = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", leader]))
          // The host has finished its initial snapshot before this file exists;
          // that snapshot can only contain the leader, never its future child.
          writeFileSync(trigger, "go")
          expect(yield* handle.exitCode).toBe(0)
          const readyBy = Date.now() + 5000
          while (readBeat(heartbeat) === undefined && Date.now() < readyBy) yield* Effect.sleep(10)
          expect(readBeat(heartbeat)?.token).toBe(token)
        }).pipe(
          Effect.provide(BunHost.layerContained({ graceMs: 80 })),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped,
          Effect.exit
        )
        expect(readBeat(heartbeat), JSON.stringify(close)).toBeDefined()
        const before = readBeat(heartbeat)!
        yield* Effect.sleep(150)
        const after = readBeat(heartbeat)!
        const processIdentity = identity(after.pid)
        const live = yield* ledger.live
        expect(
          {
            closeSucceeded: Exit.isSuccess(close),
            heartbeatStopped: before.tick === after.tick,
            childGone: processIdentity === "gone" || /^\d+\s+\d+\s+\d+\s+Z/.test(processIdentity),
            retainedRecords: live.length
          },
          JSON.stringify({ token, childPid: after.pid, firstTick: before.tick, lastTick: after.tick, processIdentity })
        ).toEqual({ closeSucceeded: true, heartbeatStopped: true, childGone: true, retainedRecords: 0 })
      } finally {
        const beat = readBeat(heartbeat)
        if (beat !== undefined && identity(beat.pid).includes(token)) process.kill(beat.pid, "SIGKILL")
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.live("finishes output collection when a naturally exited target leaves a child holding stdout", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "flows-inherited-output-"))
      const token = randomUUID()
      const heartbeat = join(directory, "heartbeat.json")
      const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
        JSON.stringify(heartbeat)
      };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,25)`
      const leader =
        `const fs=require('node:fs');const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${
          JSON.stringify(child)
        }],{stdio:['ignore','inherit','inherit']}).unref();const ready=setInterval(()=>{if(fs.existsSync(${
          JSON.stringify(heartbeat)
        })){clearInterval(ready);process.stdout.write('target-complete\\n',()=>process.exit(0))}},5)`
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "inherited-output", ownerPid: process.pid })
      try {
        const output = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          // No caller waits on exitCode or closes the scope while collecting.
          // The host must notice target exit independently of stdout's EOF.
          return yield* spawner.string(ChildProcess.make(process.execPath, ["-e", leader])).pipe(
            Effect.timeout("3 seconds")
          )
        }).pipe(
          Effect.provide(BunHost.layerContained({ graceMs: 80 })),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(output).toBe("target-complete\n")
        const stopped = readBeat(heartbeat)!
        expect(stopped.token).toBe(token)
        yield* Effect.sleep(150)
        expect(readBeat(heartbeat)!.tick).toBe(stopped.tick)
        const after = identity(stopped.pid)
        expect(after === "gone" || /^\d+\s+\d+\s+\d+\s+Z/.test(after), after).toBe(true)
        expect(yield* ledger.live).toEqual([])
      } finally {
        const beat = readBeat(heartbeat)
        if (beat !== undefined && identity(beat.pid).includes(token)) process.kill(beat.pid, "SIGKILL")
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  for (const legs of [1, 2]) {
    it.live(`kills TERM-ignoring children after ${legs} pipeline leader(s) exit zero on TERM`, () =>
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "flows-leader-exit-"))
        const fixtures = Array.from({ length: legs }, (_, index) => {
          const token = randomUUID()
          const path = join(directory, `${index}.json`)
          const child = `const fs=require('node:fs');const token=${
            JSON.stringify(token)
          };let tick=0;process.on('SIGTERM',()=>{});const path=${
            JSON.stringify(path)
          };const beat=()=>{fs.writeFileSync(path+".tmp",JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+".tmp",path)};beat();setInterval(beat,25)`
          const leader =
            `const{spawn}=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));spawn(process.execPath,['-e',${
              JSON.stringify(child)
            }],{stdio:'ignore'});setInterval(()=>{},1000)`
          return { token, path, command: ChildProcess.make(process.execPath, ["-e", leader]) }
        })
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "leader-exit", ownerPid: process.pid })
        try {
          yield* Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const command = legs === 1
              ? fixtures[0]!.command
              : ChildProcess.pipeTo(fixtures[0]!.command, fixtures[1]!.command)
            const handle = yield* spawner.spawn(command)
            for (const fixture of fixtures) {
              const readyBy = Date.now() + 5000
              while (readBeat(fixture.path) === undefined && Date.now() < readyBy) yield* Effect.sleep(10)
              const beat = readBeat(fixture.path)
              expect(beat?.token).toBe(fixture.token)
              expect(identity(beat!.pid)).toContain(fixture.token)
            }
            const live = yield* ledger.live
            expect(live).toHaveLength(legs)
            expect(new Set(live.map((record) => record.pid)).size).toBe(legs)
            expect(live.at(-1)?.pid).toBe(handle.pid)
          }).pipe(
            Effect.provide(BunHost.layerContained({ graceMs: 80 })),
            Effect.provideService(ProcessLedger.ProcessLedger, ledger),
            Effect.scoped
          )
          expect(yield* ledger.live).toEqual([])
          const stopped = fixtures.map((fixture) => readBeat(fixture.path)!.tick)
          yield* Effect.sleep(150)
          expect(fixtures.map((fixture) => readBeat(fixture.path)!.tick)).toEqual(stopped)
          for (const fixture of fixtures) {
            const after = identity(readBeat(fixture.path)!.pid)
            expect(after === "gone" || /^\d+\s+\d+\s+\d+\s+Z/.test(after), after).toBe(true)
          }
        } finally {
          for (const fixture of fixtures) {
            const beat = readBeat(fixture.path)
            if (beat !== undefined && identity(beat.pid).includes(fixture.token)) process.kill(beat.pid, "SIGKILL")
          }
          rmSync(directory, { recursive: true, force: true })
        }
      }))
  }
  for (const detached of [true, false]) {
    it.live(
      `does not spend the grace window on a completed command (detached=${detached})`,
      () =>
        Effect.gen(function*() {
          // The property is "scope close after a completed command does not wait
          // out the grace window", so only the exit-to-close span is measured, and
          // the window is long enough that no load on the host reaches it. Layer
          // build and the spawn itself are not the grace window.
          const graceMs = 20_000
          const ledger = yield* ProcessLedger.makeMemory({ hostId: "fast-exit", ownerPid: process.pid })
          let exitedAt = 0
          const status = yield* Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], { detached })
            )
            const code = yield* handle.exitCode
            exitedAt = Date.now()
            return code
          }).pipe(
            Effect.provide(BunHost.layerContained({ graceMs })),
            Effect.provideService(ProcessLedger.ProcessLedger, ledger),
            Effect.scoped
          )
          expect(status).toBe(0)
          expect(Date.now() - exitedAt).toBeLessThan(graceMs / 2)
          expect(yield* ledger.live).toEqual([])
        }),
      60_000
    )
  }
})
