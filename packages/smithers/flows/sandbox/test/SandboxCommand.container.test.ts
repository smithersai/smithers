/**
 * The command scripts in a real container, as a branch's box runs them: Debian's `sh` (dash), util-linux `setsid`, GNU
 * `timeout`, a reaping init as PID 1, and an ordinary user. Each operation is a fresh `exec`, and closing a session kills its
 * exec, as a host that stops drops it. Runs with Docker or Podman; skips only when neither answers.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema, Stream } from "effect"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import type { Readable } from "node:stream"
import { afterAll, beforeAll } from "vitest"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxCommand from "../src/SandboxCommand/index.ts"
import * as SandboxTools from "../src/SandboxTools/index.ts"
import { discover } from "./helpers/discover.ts"

const cli = ["docker", "podman"].find((name) => discover(name, ["info"]).status === 0)
const image = "docker.io/library/debian:trixie-slim"
const name = `smthrs-command-${process.pid}`
const calls = "/home/u/calls"
const USER = "1000:1000"
/**
 * How long the opt-in long command runs, in seconds: unset or 0 skips it. Set it past 900 (Cloudflare's alarm limit) to
 * prove a command outlives any one host's drive: `SANDBOX_LONG_COMMAND_SECONDS=960`.
 */
const LONG_SECONDS = Number(process.env.SANDBOX_LONG_COMMAND_SECONDS ?? "0")
/**
 * PID 1: an init that reaps every orphan reparented to it, as the branch's box's tini does. Debian's slim image has Perl
 * and no init, and an engine's `--init` binary isn't always installed.
 */
const REAPER = "$SIG{CHLD} = sub { 1 while waitpid(-1, 1) > 0 }; sleep while 1"

/** Runs `script` in the container as `user`: its standard output, failing the test when it fails. */
const inside = (script: string, user = "0:0"): string =>
  execFileSync(cli!, ["exec", "--user", user, name, "sh", "-c", script], { encoding: "utf8" })

/** Whether `script` exits 0 in the container as the user. */
const holds = (script: string): boolean =>
  spawnSync(cli!, ["exec", "--user", USER, name, "sh", "-c", script], { stdio: "ignore" }).status === 0

const fromReadable = (readable: Readable) =>
  Stream.fromAsyncIterable(
    readable as AsyncIterable<Uint8Array>,
    (cause) => new ProviderError({ code: "unknown", message: String(cause) })
  ).pipe(Stream.map((chunk) => new Uint8Array(chunk)))

/** A session on the container as the user, in `/workspace`: each command is one `exec`, killed when its scope closes. */
const session: Sandbox.Session = {
  id: name,
  remoteId: name,
  workdir: "/workspace",
  spawn: (command, options) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        spawn(cli!, ["exec", "-i", "--user", USER, "-w", "/workspace", name, "sh", "-c", command], {
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
        })
      ),
      (child) => Effect.sync(() => child.exitCode === null && child.kill("SIGKILL"))
    ).pipe(Effect.map((child) => {
      const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 137)))
      if (options.stdin !== undefined) child.stdin!.end(options.stdin)
      return {
        stdout: fromReadable(child.stdout!),
        stderr: fromReadable(child.stderr!),
        exitCode: Effect.promise(() => exited)
      }
    })),
  readFile: () => Effect.die("the commands read through scripts"),
  writeFile: () => Effect.die("the commands write through scripts")
}

/** One operation in a session of its own, closed when it answers. */
const op = <A, E>(body: (session: Sandbox.Session) => Effect.Effect<A, E>) => Effect.scoped(body(session))

/** Waits, up to five seconds, until no process of group `pgid` is left for the init to reap. */
const gone = (pgid: string | number) =>
  Effect.gen(function*() {
    for (let tries = 0; tries < 50 && holds(`kill -0 -${pgid}`); tries++) yield* Effect.sleep("100 millis")
    return !holds(`kill -0 -${pgid}`)
  })

/** Observes `key` until its command no longer runs. */
const settled = (key: string) =>
  Effect.gen(function*() {
    for (let tries = 0; tries < 300; tries++) {
      const observed = yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))
      if (observed.state !== "running") return observed
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die("the command never stopped")
  })

describe.skipIf(cli !== undefined)("SandboxTools' container capability guard", () => {
  it("is skipped because neither Docker nor Podman answers its info command", () => {
    expect(cli).toBeUndefined()
  })
})

describe.skipIf(cli === undefined)("SandboxTools' command scripts in a real container", () => {
  beforeAll(() => {
    execFileSync(
      cli!,
      ["run", "-d", "--name", name, "--network", "none", "--entrypoint", "perl", image, "-e", REAPER],
      {
        stdio: "inherit"
      }
    )
    inside("mkdir -p /workspace /home/u && chown 1000:1000 /workspace /home/u")
  }, 600_000)

  afterAll(() => {
    spawnSync(cli!, ["rm", "--force", name], { stdio: "ignore" })
  })

  it.live(
    "starts once, outlives its exec, runs, finishes, collects once, and the same key starts nothing",
    () =>
      Effect.gen(function*() {
        const key = "install#g1"
        const call = { tool: "run", command: "echo ran >> runs.log; sleep 2; echo done-$((2+3))" } as const
        const started = yield* op((s) => SandboxTools.start(s, call, { key, callsDirectory: calls }))
        // The exec that started it is gone; the command runs on in its own process group.
        expect(holds(`kill -0 -${started.pid}`)).toBe(true)
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).toEqual({
          state: "running",
          pid: started.pid
        })
        expect(yield* settled(key)).toEqual({ state: "finished", exitCode: 0, timedOut: false })
        const collected = yield* op((s) => SandboxTools.collect(s, { key, callsDirectory: calls }))
        expect(collected).toMatchObject({ exitCode: 0, stdout: "done-5\n", stderr: "" })
        expect(yield* op((s) => SandboxTools.collect(s, { key, callsDirectory: calls }))).toEqual(collected)
        expect(yield* op((s) => SandboxTools.start(s, call, { key, callsDirectory: calls }))).toEqual(started)
        expect(inside("cat /workspace/runs.log")).toBe("ran\n")
      }),
    60_000
  )

  it.live(
    "cancel stops the command's whole process group, a child in the background included",
    () =>
      Effect.gen(function*() {
        const key = "long#g1"
        const started = yield* op((s) =>
          SandboxTools.start(s, { tool: "run", command: "sleep 300 & sleep 300; wait" }, { key, callsDirectory: calls })
        )
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).toMatchObject({
          state: "running"
        })
        const child = inside(`cut -d' ' -f1 ${calls}/command-long_23g1/child`).trim()
        expect(holds(`kill -0 -${child}`)).toBe(true)
        yield* op((s) => SandboxTools.cancel(s, { key, callsDirectory: calls }))
        expect(yield* gone(started.pid)).toBe(true)
        expect(yield* gone(child)).toBe(true)
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).not.toMatchObject({
          state: "running"
        })
      }),
    60_000
  )

  it.live(
    "a command the container restarted under is lost: it observes lost, collects ToolLost, and cancels nothing",
    () =>
      Effect.gen(function*() {
        const key = "restarted#g1"
        yield* op((s) => SandboxTools.start(s, { tool: "run", command: "sleep 300" }, { key, callsDirectory: calls }))
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).toMatchObject({
          state: "running"
        })
        execFileSync(cli!, ["restart", "--time", "1", name], { stdio: "ignore" })
        // The disk kept the fence; its pid may name another process now, and still reads as lost.
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).toEqual({ state: "lost" })
        expect(yield* Effect.flip(op((s) => SandboxTools.collect(s, { key, callsDirectory: calls })))).toEqual(
          new SandboxTools.ToolLost()
        )
        yield* op((s) => SandboxTools.cancel(s, { key, callsDirectory: calls }))
        expect(yield* op((s) => SandboxTools.observe(s, { key, callsDirectory: calls }))).toEqual({ state: "lost" })
      }),
    120_000
  )

  // The job over the container's command operations, each a fresh exec, run by the in-memory flow engine: the run parks
  // between probes and no exec waits on the command.
  const Long = SandboxCommand.make("test/long-command", { target: Schema.Struct({}) })
  const LongRun = Flow.make("test/run-long-command", {
    payload: Long.payloadSchema,
    success: Long.successSchema,
    error: Long.errorSchema,
    body: Node.capture({ job: Long._tag }, (payload) => Long.call(payload))
  })
  const longLayer = Layer.mergeAll(
    Long.toLayer(SandboxCommand.operations(() =>
      Effect.succeed<SandboxCommand.Commands>({
        start: (call, key) => op((s) => SandboxCommand.onSession(s, calls).start(call, key)),
        observe: (key) => op((s) => SandboxCommand.onSession(s, calls).observe(key)),
        collect: (key) => op((s) => SandboxCommand.onSession(s, calls).collect(key)),
        cancel: (key) => op((s) => SandboxCommand.onSession(s, calls).cancel(key))
      })
    )),
    Interpreter.layer(LongRun)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

  it.live.runIf(LONG_SECONDS > 0)(
    `a job runs a ${LONG_SECONDS}-second command past SandboxTools' 600 s to its result (SANDBOX_LONG_COMMAND_SECONDS)`,
    () =>
      Effect.gen(function*() {
        const began = Date.now()
        const result = yield* LongRun.execute({
          target: {},
          call: {
            tool: "run",
            command: `echo ran >> long.log; sleep ${LONG_SECONDS}; echo done-${LONG_SECONDS}`,
            timeoutSeconds: LONG_SECONDS + 240
          }
        })
        expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: `done-${LONG_SECONDS}\n`, stderr: "" })
        expect(Date.now() - began).toBeGreaterThanOrEqual(LONG_SECONDS * 1000)
        expect(inside("cat /workspace/long.log")).toBe("ran\n")
      }).pipe(Effect.provide(longLayer)),
    (LONG_SECONDS + 600) * 1000
  )
})
