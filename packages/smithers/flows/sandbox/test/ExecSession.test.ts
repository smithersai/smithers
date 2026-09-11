import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { envPrefix } from "../src/internal/envPrefix.ts"
import { execSession, type ExecSessionOptions } from "../src/internal/execSession.ts"
import type { GatheredRun } from "../src/internal/localProcess.ts"
import { pidDirectory } from "../src/internal/pidDirectory.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const handle = (exitCode: number, stdout = "") =>
  makeHandle({
    pid: ProcessId(1),
    exitCode: Effect.succeed(ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: stdout === "" ? Stream.empty : Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })

/** A transport that records every argv and answers from a script table. */
const transport = (
  encode: "raw" | "base64",
  answer: (script: string) => GatheredRun = () => ({ code: 0, stdout: new Uint8Array(), stderr: "" })
) => {
  const runs: Array<ReadonlyArray<string>> = []
  const launches: Array<{ readonly args: ReadonlyArray<string>; readonly stdin: string | undefined }> = []
  const options: ExecSessionOptions = {
    id: "key",
    name: "box",
    noun: "box",
    program: "cli",
    workdir: "/w",
    encode,
    run: (args) =>
      Effect.sync(() => {
        runs.push(args)
        return answer(args.at(-1)!)
      }),
    launch: (args, stdin) =>
      Effect.gen(function*() {
        const input = stdin === undefined
          ? undefined
          : yield* Stream.runFold(stdin, () => "", (text, bytes) => text + decoder.decode(bytes))
        launches.push({ args, stdin: input })
        return handle(0)
      }),
    shell: (script, interactive) => ["exec", ...interactive ? ["-i"] : [], "box", "/bin/sh", "-c", script],
    spawn: ({ command, cwd, record, stdin }) => [
      "exec",
      ...stdin === undefined ? [] : ["-i"],
      "box",
      [`cd ${cwd}`, ...record, command].join(" && ")
    ],
    ping: ["exec", "box", "true"]
  }
  return { launches, options, runs }
}

describe("envPrefix", () => {
  it("puts every removal before every assignment, quoted", () => {
    expect(envPrefix({ A: "1", B: undefined, C: "two words", D: undefined })).toEqual([
      "-u",
      "B",
      "-u",
      "D",
      "A=1",
      "'C=two words'"
    ])
    expect(envPrefix(undefined)).toEqual([])
  })
})

describe("execSession", () => {
  it.effect("prepares the pidfile directory before serving the session", () =>
    Effect.gen(function*() {
      const fake = transport("raw")
      const session = yield* execSession(fake.options)
      expect(session.remoteId).toBe("box")
      expect(fake.runs[0]!.at(-1)).toBe(`mkdir -p /w && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`)
    }))

  it.effect("refuses a machine whose workspace could not be prepared", () =>
    Effect.gen(function*() {
      const fake = transport("raw", () => ({ code: 1, stdout: new Uint8Array(), stderr: "read-only\n" }))
      const error = yield* Effect.flip(execSession(fake.options))
      expect(error.code).toBe("unavailable")
      expect(error.message).toBe("the workspace /w could not be prepared in box: `cli exec` exited 1: read-only")
    }))

  it.effect("numbers pidfiles per acquire and kills the process's own pidfile", () =>
    Effect.gen(function*() {
      const fake = transport("raw")
      const session = yield* execSession(fake.options)
      const scope = yield* Scope.make()
      const first = yield* Scope.provide(session.spawn("true", { cwd: "sub" }), scope)
      const second = yield* Scope.provide(session.spawn("true", {}), scope)
      expect(fake.launches.map(({ args }) => args.at(-1)!.split(" && ").slice(0, 2))).toEqual([
        ["cd /w/sub", `echo $$ > ${pidDirectory}/0.pid`],
        ["cd /w", `echo $$ > ${pidDirectory}/1.pid`]
      ])
      yield* session.kill!(second, "SIGKILL")
      yield* session.kill!(first, "SIGTERM")
      const kills = fake.runs.slice(1).map((args) => args.at(-1)!)
      expect(kills[0]).toContain(`${pidDirectory}/1.pid`)
      expect(kills[0]).toContain("KILL")
      expect(kills[1]).toContain(`${pidDirectory}/0.pid`)
      yield* Scope.close(scope, Exit.void)
    }))

  it.effect("signals an unobserved guest when the spawn scope closes, and spares an ended one", () =>
    Effect.gen(function*() {
      const fake = transport("raw")
      const session = yield* execSession(fake.options)
      const ended = yield* Scope.make()
      const process = yield* Scope.provide(session.spawn("true", {}), ended)
      yield* process.exitCode
      yield* Scope.close(ended, Exit.void)
      expect(fake.runs).toHaveLength(1)
      const running = yield* Scope.make()
      yield* Scope.provide(session.spawn("sleep 9", {}), running)
      yield* Scope.close(running, Exit.void)
      expect(fake.runs).toHaveLength(2)
      expect(fake.runs[1]!.at(-1)).toContain(`${pidDirectory}/1.pid`)
    }))

  it.effect("carries the environment and stdin on the input channel, never in argv", () =>
    Effect.gen(function*() {
      const fake = transport("raw")
      const session = yield* execSession(fake.options)
      yield* Effect.scoped(session.spawn("cat", { env: { SECRET: "s3cr3t" }, stdin: encoder.encode("body") }))
      const [launch] = fake.launches
      expect(launch!.args[1]).toBe("-i")
      expect(launch!.args.join(" ")).not.toContain("s3cr3t")
      expect(launch!.args.at(-1)).toContain(`exec env "$@" /bin/sh -c cat`)
      expect(launch!.stdin).toMatch(/\nbody$/)
    }))

  it.effect("moves file bytes verbatim or as base64 and maps a missing path to not_found", () =>
    Effect.gen(function*() {
      const raw = transport("raw", (script) =>
        script.startsWith("test -e")
          ? { code: 0, stdout: encoder.encode("hi"), stderr: "" }
          : { code: 0, stdout: new Uint8Array(), stderr: "" })
      const rawSession = yield* execSession(raw.options)
      expect(decoder.decode(yield* rawSession.readFile("/w/a"))).toBe("hi")
      yield* rawSession.writeFile("/w/d/a", encoder.encode("hi"))
      expect(raw.runs[1]!.at(-1)).toBe("test -e /w/a || exit 9; cat /w/a")
      expect(raw.launches[0]).toEqual({
        args: ["exec", "-i", "box", "/bin/sh", "-c", "mkdir -p /w/d && cat > /w/d/a"],
        stdin: "hi"
      })

      const encoded = transport("base64", (script) =>
        script.startsWith("test -e")
          ? { code: 9, stdout: new Uint8Array(), stderr: "" }
          : { code: 0, stdout: new Uint8Array(), stderr: "" })
      const encodedSession = yield* execSession(encoded.options)
      const missing = yield* Effect.flip(encodedSession.readFile("/w/a"))
      expect(missing.code).toBe("not_found")
      expect(missing.message).toBe("the box holds nothing at /w/a")
      expect(encoded.runs[1]!.at(-1)).toBe("test -e /w/a || exit 9; base64 < /w/a")
      yield* encodedSession.writeFile("/w/a", encoder.encode("hi"))
      expect(encoded.launches[0]!.args.at(-1)).toBe("mkdir -p /w && base64 -d > /w/a")
      expect(encoded.launches[0]!.stdin).toBe("aGk=")
    }))

  it.effect("pings through the provider's probe", () =>
    Effect.gen(function*() {
      const fake = transport("raw", (script) =>
        script === "true"
          ? { code: 1, stdout: new Uint8Array(), stderr: "gone" }
          : { code: 0, stdout: new Uint8Array(), stderr: "" })
      const session = yield* execSession(fake.options)
      const error = yield* Effect.flip(session.ping!)
      expect(fake.runs.at(-1)).toEqual(["exec", "box", "true"])
      expect(error.message).toBe("the box box did not answer: gone")
    }))
})
