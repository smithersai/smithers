import * as NodeSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import { policy } from "../src/internal/ProcessCleanup.ts"
import { prepare, targetPidOf } from "../src/internal/ProcessSupervisor.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import { waitForExit } from "./helpers/waitForExit.ts"

const rawLayer = NodeSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
const layers = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command) => PipedProcess.spawn(command as ChildProcess.StandardCommand, undefined))
)
const contained = ProcessReaper.layerSpawner().pipe(Layer.provide(rawLayer))
const fixture = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-supervisor-contract-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
)
const text = (value: string) => Stream.make(new TextEncoder().encode(value))
const output = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)
const group = (pid: number) =>
  Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim())
const hostFixture = fileURLToPath(new URL("./fixtures/supervised-host.ts", import.meta.url))
/** What the fixture host reports once its target and that target's child run. */
type Ready = {
  readonly host: number
  readonly supervisor: number
  readonly target: number
  readonly grandchild: number
  readonly graceMs: number
}
const commandOf = (pid: number) =>
  spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).stdout ?? ""
const beatOf = (path: string): { readonly token: string; readonly pid: number; readonly tick: number } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

describe.skipIf(process.platform === "win32")("prepared POSIX process contract", () => {
  for (const operation of ["stdout", "stdin", "custom-output", "custom-input"] as const) {
    it.live(`fails ${operation} when the owner dies before target status instead of hanging on a live target`, () =>
      Effect.gen(function*() {
        const directory = yield* fixture
        const token = randomUUID()
        const marker = join(directory, "ready")
        let target: number | undefined
        let result = ""
        const identity = (pid: number) =>
          spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 1000
          }).stdout
        const stopped = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make(process.execPath, [
              "-e",
              `const token=${JSON.stringify(token)};require('node:fs').writeFileSync(${
                JSON.stringify(marker)
              },'ready');setInterval(()=>{},1000)`
            ], {
              env: { PATH: "/usr/bin:/bin" },
              forceKillAfter: 0,
              additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } }
            })
          )
          try {
            target = targetPidOf(handle)!
            while (!existsSync(marker)) yield* Effect.sleep(5)
            // This exact owner was created by this UUID fixture. The target is
            // deliberately left alive to hold both ends of the public pipes.
            process.kill(handle.pid, "SIGKILL")
            const read = operation === "stdout" ? handle.stdout : handle.getOutputFd(4)
            const write = operation === "stdin" ? handle.stdin : handle.getInputFd(3)
            const work = operation === "stdout" || operation === "custom-output"
              ? Stream.runDrain(read)
              : Stream.run(Stream.make(new Uint8Array(2 * 1024 * 1024)), write)
            result = JSON.stringify(yield* work.pipe(Effect.timeout("1 second"), Effect.exit))
          } finally {
            if (target !== undefined && identity(target).includes(token)) process.kill(target, "SIGKILL")
          }
        }).pipe(
          Effect.provide(contained),
          Effect.provide(ProcessLedger.layerMemory({ hostId: token, ownerPid: process.pid })),
          Effect.scoped,
          Effect.exit
        )
        expect(result).toContain("\"_tag\":\"PlatformError\"")
        expect(result).not.toContain("TimeoutError")
        // Missing target status and explicit cleanup acknowledgement remain a
        // failed release, even though the test itself removed its known child.
        expect(Exit.isFailure(stopped)).toBe(true)
      }).pipe(Effect.scoped))
  }

  it.live("shares native and private-channel unref/reref state and re-references explicit cleanup", () =>
    Effect.gen(function*() {
      const raw = yield* ChildProcessSpawner
      const prepared = yield* ProcessReaper.processLifecycle(ChildProcess.make("/bin/cat"), raw.spawn)
      yield* prepared.activate
      const first = yield* prepared.handle.unref
      const second = yield* prepared.handle.unref
      yield* first
      yield* second
      yield* prepared.handle.unref
      const refused = yield* Effect.exit(prepared.handle.kill({ killSignal: "SIGSTOP" }))
      expect(Exit.isFailure(refused)).toBe(true)
      expect(yield* prepared.handle.isRunning).toBe(true)
      yield* prepared.handle.kill()
      expect(yield* prepared.settled).toBe(true)
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("settles an unactivated direct owner without launching its target", () =>
    Effect.gen(function*() {
      const directory = yield* fixture
      const marker = join(directory, "must-not-start")
      const raw = yield* ChildProcessSpawner
      const prepared = yield* ProcessReaper.processLifecycle(
        ChildProcess.make("/bin/sh", ["-c", "printf started > \"$1\"", "target", marker], { detached: false }),
        raw.spawn
      )
      expect(targetPidOf(prepared.handle)).toBeUndefined()
      yield* prepared.handle.kill()
      expect(yield* prepared.settled).toBe(true)
      expect(yield* prepared.handle.isRunning).toBe(false)
      expect(existsSync(marker)).toBe(false)
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("merges inherited environment in the host before isolating the supervisor", () =>
    Effect.gen(function*() {
      const token = randomUUID().replaceAll("-", "_")
      const inherited = `SMITHERS_ENV_${token}`
      const overridden = `${inherited}_OVERRIDE`
      process.env[inherited] = "from host"
      process.env[overridden] = "old value"
      try {
        const raw = yield* ChildProcessSpawner
        const prepared = yield* ProcessReaper.processLifecycle(
          ChildProcess.make("/bin/sh", ["-c", `printf '%s|%s' "$${inherited}" "$${overridden}"`], {
            extendEnv: true,
            env: { [overridden]: "from command" }
          }),
          raw.spawn
        )
        yield* prepared.activate
        expect(yield* output(prepared.handle.stdout)).toBe("from host|from command")
        expect(yield* prepared.handle.exitCode).toBe(0)
        yield* prepared.handle.kill()
        expect(yield* prepared.settled).toBe(true)
      } finally {
        delete process.env[inherited]
        delete process.env[overridden]
      }
    }).pipe(Effect.provide(layers), Effect.scoped))

  for (const unknown of ["unavailable", "own-group"] as const) {
    it.live(`retains a record when post-exit cleanup observation is ${unknown}`, () =>
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "unverified-owner", ownerPid: process.pid })
        let observations = 0
        const result = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "exit 0"]))
          expect(yield* handle.exitCode).toBe(0)
        }).pipe(
          Effect.provide(ContainedSpawner.layer(
            { graceMs: 0 },
            prepare({
              platform: process.platform,
              snapshot: (pid) => {
                observations++
                return unknown === "unavailable" ? undefined : { ownGroup: pid, members: [] }
              }
            }, policy)
          )),
          Effect.provide(layers),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped,
          Effect.exit
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect(observations).toBeGreaterThan(1)
        expect(yield* ledger.live).toHaveLength(1)
      }))
  }

  it.live("gates real target execution and preserves literal argv, private env and caller fds", () =>
    Effect.gen(function*() {
      const directory = yield* fixture
      const token = randomUUID()
      const marker = join(directory, "started")
      const poisoned = join(directory, "preload.cjs")
      writeFileSync(
        poisoned,
        `require('node:fs').writeFileSync(${JSON.stringify(join(directory, "preload-ran"))},'bad')`
      )
      writeFileSync(join(directory, ".env"), "UNEXPECTED_DOTENV=bad\n")
      writeFileSync(join(directory, "bunfig.toml"), `preload = [${JSON.stringify(poisoned)}]\n`)
      const raw = yield* ChildProcessSpawner
      let helper: ChildProcess.StandardCommand | undefined
      const prepared = yield* ProcessReaper.processLifecycle(
        ChildProcess.make("/bin/sh", [
          "-c",
          "printf started > \"$1\"; IFS= read -r input <&4; printf \"%s:%s:%s\\n\" \"$2\" \"$input\" \"$CANARY\"; printf ERR >&2; printf EXTRA >&3; exit 17",
          "target",
          marker,
          "literal $ ; 界"
        ], {
          cwd: directory,
          env: {
            PATH: "/usr/bin:/bin",
            CANARY: token,
            NODE_OPTIONS: `--require=${poisoned}`,
            BUN_OPTIONS: `--preload=${poisoned}`,
            HOME: directory
          },
          additionalFds: { fd3: { type: "output" }, fd4: { type: "input", stream: text("custom input\n") } }
        }),
        (command) => {
          helper = command
          return raw.spawn(command)
        }
      )
      expect(existsSync(marker)).toBe(false)
      expect(targetPidOf(prepared.handle)).toBeUndefined()
      expect(helper!.options).toMatchObject({ cwd: "/", extendEnv: false, shell: false })
      expect(helper!.options.env).not.toHaveProperty("NODE_OPTIONS")
      expect(helper!.options.env).not.toHaveProperty("BUN_OPTIONS")
      expect(existsSync(helper!.args.at(-2)!)).toBe(false)
      yield* prepared.activate
      yield* prepared.activate
      expect(targetPidOf(prepared.handle)).not.toBe(prepared.handle.pid)
      expect(
        yield* Effect.all([
          output(prepared.handle.stdout),
          output(prepared.handle.stderr),
          output(prepared.handle.getOutputFd(3)),
          prepared.handle.exitCode
        ], { concurrency: "unbounded" })
      )
        .toEqual([`literal $ ; 界:custom input:${token}\n`, "ERR", "EXTRA", 17])
      expect(readFileSync(marker, "utf8")).toBe("started")
      expect(existsSync(join(directory, "preload-ran"))).toBe(false)
      yield* prepared.handle.kill()
      expect(yield* prepared.settled).toBe(true)
    }).pipe(Effect.provide(layers), Effect.scoped))

  for (const kind of ["missing", "nonexecutable"] as const) {
    it.live(`preserves actual ${kind} spawn errno and settles without a target`, () =>
      Effect.gen(function*() {
        const directory = yield* fixture
        const file = join(directory, kind)
        if (kind === "nonexecutable") {
          writeFileSync(file, "#!/bin/sh\nexit 0\n")
          chmodSync(file, 0o600)
        }
        const raw = yield* ChildProcessSpawner
        const prepared = yield* ProcessReaper.processLifecycle(
          ChildProcess.make(file, [], { detached: false }),
          raw.spawn
        )
        const result = yield* Effect.exit(prepared.activate)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(false)
          expect(JSON.stringify(result.cause)).toContain(kind === "missing" ? "NotFound" : "PermissionDenied")
        }
        yield* prepared.handle.kill()
        expect(yield* prepared.settled).toBe(true)
        expect(yield* prepared.handle.isRunning).toBe(false)
      }).pipe(Effect.provide(layers), Effect.scoped))
  }

  it.live("preserves detached:false and the target's exact nonzero outcome", () =>
    Effect.gen(function*() {
      const raw = yield* ChildProcessSpawner
      const prepared = yield* ProcessReaper.processLifecycle(
        ChildProcess.make("/bin/sh", ["-c", "read answer; exit 23"], {
          detached: false
        }),
        raw.spawn
      )
      yield* prepared.activate
      expect(group(prepared.handle.pid)).toBe(group(process.pid))
      expect(group(targetPidOf(prepared.handle)!)).toBe(group(process.pid))
      yield* Stream.run(text("done\n"), prepared.handle.stdin)
      expect(yield* prepared.handle.exitCode).toBe(23)
      yield* prepared.handle.kill()
      expect(yield* prepared.settled).toBe(true)
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("keeps an exotic catchable signal from terminating the cleanup owner", () =>
    Effect.gen(function*() {
      const raw = yield* ChildProcessSpawner
      const prepared = yield* ProcessReaper.processLifecycle(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.on('SIGHUP',()=>process.exit(19));process.stdout.write('ready\\n');setInterval(()=>{},1000)"
        ], {
          env: { PATH: "/usr/bin:/bin" },
          forceKillAfter: 50
        }),
        raw.spawn
      )
      yield* prepared.activate
      yield* prepared.handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
      yield* prepared.handle.kill({ killSignal: "SIGHUP" })
      expect(yield* prepared.handle.exitCode).toBe(19)
      expect(yield* prepared.settled).toBe(true)
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("records an actual target signal without inventing an exit code", () =>
    Effect.gen(function*() {
      const raw = yield* ChildProcessSpawner
      const prepared = yield* ProcessReaper.processLifecycle(
        ChildProcess.make("/bin/sh", ["-c", "kill -INT $$"]),
        raw.spawn
      )
      yield* prepared.activate
      const result = yield* Effect.exit(prepared.handle.exitCode)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(JSON.stringify(result.cause)).toContain("\"signal\":\"SIGINT\"")
      yield* prepared.handle.kill()
      expect(yield* prepared.settled).toBe(true)
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("keeps an escaped child's escalation deadline after its live target exits on TERM", () =>
    Effect.gen(function*() {
      const directory = yield* fixture
      const token = randomUUID()
      const heartbeat = join(directory, "escaped.json")
      const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};let tick=0;
        process.on('SIGTERM',()=>{});
        const beat=()=>{fs.writeFileSync(${
        JSON.stringify(heartbeat)
      },JSON.stringify({token,pid:process.pid,tick:tick++}))};
        beat();setInterval(beat,20);process.send('ready');process.disconnect()`
      const leader = `const cp=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));
        const child=cp.spawn(process.execPath,['-e',${
        JSON.stringify(child)
      }],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
        child.once('message',()=>process.stdout.write('ready\\n'));setInterval(()=>{},1000)`
      let escapedPid: number | undefined
      try {
        const raw = yield* ChildProcessSpawner
        const prepared = yield* ProcessReaper.processLifecycle(
          ChildProcess.make(process.execPath, ["-e", leader], {
            env: { PATH: "/usr/bin:/bin" },
            forceKillAfter: 100
          }),
          raw.spawn
        )
        yield* prepared.activate
        yield* prepared.handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
        const beat = JSON.parse(readFileSync(heartbeat, "utf8")) as { token: string; pid: number }
        expect(beat.token).toBe(token)
        escapedPid = beat.pid
        expect(group(escapedPid)).toBe(escapedPid)
        yield* prepared.handle.kill()
        expect(yield* prepared.handle.exitCode).toBe(0)
        expect(yield* prepared.settled).toBe(true)
        const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(escapedPid)], { encoding: "utf8" })
        expect(status.status !== 0 || status.stdout.trim().startsWith("Z"), status.stdout).toBe(true)
      } finally {
        if (escapedPid !== undefined) {
          const identity = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(escapedPid)], {
            encoding: "utf8"
          })
          if (identity.stdout.includes(token)) process.kill(escapedPid, "SIGKILL")
        }
      }
    }).pipe(Effect.provide(layers), Effect.scoped))

  it.live("stops a killed host's own target and its child without a replacement host", () =>
    Effect.gen(function*() {
      const directory = yield* fixture
      const token = randomUUID()
      const beats = { target: join(directory, "target.json"), child: join(directory, "child.json") }
      // A separate process is the only way to lose a real host: this suite's
      // own runtime must survive to observe what that host's supervisor did.
      const host = spawn(process.execPath, [hostFixture, directory, token], { stdio: ["ignore", "pipe", "pipe"] })
      let reported: Ready | undefined
      let out = ""
      let err = ""
      try {
        host.stdout!.setEncoding("utf8")
        host.stdout!.on("data", (chunk: string) => void (out += chunk))
        host.stderr!.setEncoding("utf8")
        host.stderr!.on("data", (chunk: string) => void (err += chunk))
        const readyBy = Date.now() + 20_000
        while (reported === undefined && host.exitCode === null && Date.now() < readyBy) {
          const line = out.split("\n").find((value) => value.startsWith("{"))
          if (line === undefined) yield* Effect.sleep(20)
          else reported = JSON.parse(line)
        }
        expect(reported, JSON.stringify({ out, err, exitCode: host.exitCode })).toBeDefined()
        const ready = reported!
        const started = { target: beatOf(beats.target), child: beatOf(beats.child) }
        expect([started.target?.token, started.child?.token]).toEqual([token, token])
        expect([started.target?.pid, started.child?.pid]).toEqual([ready.target, ready.grandchild])
        // Both workloads are doing work at the moment the host dies, so their
        // stopped heartbeats afterwards cannot predate that death.
        const workingBy = Date.now() + 5000
        const advanced = () => ({
          target: beatOf(beats.target)!.tick > started.target!.tick,
          child: beatOf(beats.child)!.tick > started.child!.tick
        })
        while (Date.now() < workingBy && !(advanced().target && advanced().child)) yield* Effect.sleep(10)
        expect(advanced()).toEqual({ target: true, child: true })
        // Only the host dies, and nothing here starts another one or reaps for
        // it. Both workloads ignore SIGTERM, so the supervisor's own loss of
        // the private channel is the single remaining cause of their exits.
        process.kill(ready.host, "SIGKILL")
        const budget = ready.graceMs + 8000
        expect(
          yield* Effect.promise(() =>
            Promise.all([
              waitForExit(ready.target, budget),
              waitForExit(ready.grandchild, budget),
              waitForExit(ready.supervisor, budget)
            ])
          )
        ).toEqual([true, true, true])
        const last = { target: beatOf(beats.target)!.tick, child: beatOf(beats.child)!.tick }
        yield* Effect.sleep(200)
        expect({ target: beatOf(beats.target)!.tick, child: beatOf(beats.child)!.tick }).toEqual(last)
      } finally {
        for (const pid of [host.pid, reported?.supervisor, reported?.target, reported?.grandchild]) {
          if (pid !== undefined && commandOf(pid).includes(token)) process.kill(pid, "SIGKILL")
        }
      }
    }).pipe(Effect.scoped), 60_000)

  for (const stdio of ["ignore", "inherit"] as const) {
    it.live(`closes the helper's ${stdio} standard descriptors safely`, () =>
      Effect.gen(function*() {
        const raw = yield* ChildProcessSpawner
        const prepared = yield* ProcessReaper.processLifecycle(
          ChildProcess.make("/bin/sh", ["-c", "exit 0"], {
            stdin: stdio,
            stdout: stdio,
            stderr: stdio
          }),
          raw.spawn
        )
        yield* prepared.activate
        expect(yield* prepared.handle.exitCode).toBe(0)
        yield* prepared.handle.kill()
        expect(yield* prepared.settled).toBe(true)
      }).pipe(Effect.provide(layers), Effect.scoped))
  }
})
