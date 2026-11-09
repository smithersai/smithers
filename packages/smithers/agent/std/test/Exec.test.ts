/**
 * What a command's output costs to capture.
 *
 * `Exec` buffers, and a buffer with no bound is the whole of what a process
 * decided to print. The shell flows then display thirty kilobytes of it, so an
 * unbounded capture pays for gigabytes to show a page. `maxCaptureBytes` is the
 * bound, and these cases run a real process through the real spawner because a
 * fake one would record the option rather than produce the bytes.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Bash from "../src/Bash.vibe"
import * as Container from "../src/Container.vibe"
import * as Exec from "../src/internal/Exec.vibe"

const host = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

/** Prints `text` with no trailing newline, whatever characters it holds. */
const print = (text: string): string => `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(text)})`)}`

describe.skipIf(process.platform === "win32")("Exec capture", () => {
  it.live.each([
    {
      interpreter: "bash",
      script: "printf \"stdin:%s|%s|%s\" \"$1\" \"$2\" \"$3\"",
      args: ["-c", "printf wrong", ""],
      expected: "stdin:-c|printf wrong|"
    },
    {
      interpreter: "node",
      script: "process.stdout.write('stdin:' + process.argv.slice(2).join('|'))",
      args: ["ordinary", "-x", ""],
      expected: "stdin:ordinary|-x|"
    }
  ])(
    "runs the stdin program with exact $interpreter arguments",
    ({ interpreter, script, args, expected }) =>
      Effect.gen(function*() {
        const result = yield* Bash.run({ mode: "unhermetic", interpreter, script, args })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expected)
      }).pipe(Effect.provide(Layer.merge(host, Path.layer)))
  )

  it.live.each([
    {
      interpreter: "bash",
      script: "printf \"stdin:%s|%s|%s\" \"$1\" \"$2\" \"$3\"",
      args: ["-c", "printf wrong", ""],
      expected: "stdin:-c|printf wrong|"
    },
    {
      interpreter: "node",
      script: "process.stdout.write('stdin:' + process.argv.slice(2).join('|'))",
      args: ["ordinary", "-x", ""],
      expected: "stdin:ordinary|-x|"
    }
  ])(
    "routes $interpreter stdin and exact arguments through the container wrapper",
    ({ interpreter, script, args, expected }) =>
      Effect.gen(function*() {
        const result = yield* Bash.run({ mode: "unhermetic", container: "local", interpreter, script, args })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expected)
      }).pipe(Effect.provide(Layer.mergeAll(
        host,
        Path.layer,
        Layer.succeed(
          Container.Container,
          Container.make({
            exec: (request) => Effect.succeed({ file: request.file, args: request.args })
          })
        )
      )))
  )

  for (const tool of ["Exec", "Bash"] as const) {
    for (const declared of [false, true]) {
      it.live(`${tool} filters the parent environment with declared env=${declared}`, () =>
        Effect.gen(function*() {
          const inherited = {
            ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
            GH_TOKEN: process.env["GH_TOKEN"],
            OPENAI_API_KEY: process.env["OPENAI_API_KEY"]
          }
          process.env["ANTHROPIC_API_KEY"] = "ambient-anthropic"
          process.env["GH_TOKEN"] = "ambient-github"
          process.env["OPENAI_API_KEY"] = "ambient-openai"
          const options = declared ? { env: { SMITHERS_EXPLICIT: "visible" } } : {}
          const result = yield* Effect.gen(function*() {
            return tool === "Exec"
              ? yield* Exec.exec("printenv", options)
              : yield* Bash.run({ mode: "unhermetic", command: "printenv", ...options })
          }).pipe(
            Effect.ensuring(Effect.sync(() => {
              for (const [name, value] of Object.entries(inherited)) {
                if (value === undefined) delete process.env[name]
                else process.env[name] = value
              }
            }))
          )
          const environment = Object.fromEntries(
            result.stdout.trim().split("\n").map((line) => {
              const separator = line.indexOf("=")
              return [line.slice(0, separator), line.slice(separator + 1)]
            })
          )
          expect(environment.PATH).toBe(process.env.PATH)
          expect(environment.SMITHERS_EXPLICIT).toBe(declared ? "visible" : undefined)
          for (const name of Object.keys(inherited)) expect(environment).not.toHaveProperty(name)
        }).pipe(Effect.provide(Layer.merge(host, Path.layer))), 30_000)
    }
  }

  it.live("keeps every byte and drops none when no bound is given", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghij"))
      expect(result.stdout).toBe("abcdefghij")
      expect(result.stdoutDroppedBytes).toBe(0)
      expect(result.stderrDroppedBytes).toBe(0)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("keeps the tail and reports the bytes it dropped", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghijklmnop"), { maxCaptureBytes: 10 })
      expect(result.stdout).toBe("ghijklmnop")
      expect(result.stdoutDroppedBytes).toBe(6)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("bounds a stream far larger than the bound", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stdout.write('x'.repeat(2000000) + 'END')"`,
        { maxCaptureBytes: 64 }
      )
      expect(result.stdout.length).toBe(64)
      expect(result.stdout.endsWith("END")).toBe(true)
      expect(result.stdoutDroppedBytes).toBe(2_000_003 - 64)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("never decodes a cut code point into a replacement character", () =>
    Effect.gen(function*() {
      // Nine two-byte characters, cut at an odd byte count: the retained head
      // of the tail is one continuation byte, which is skipped rather than
      // decoded as U+FFFD, so the count says 12 dropped bytes and not 11.
      const result = yield* Exec.exec(print("é".repeat(9)), { maxCaptureBytes: 7 })
      expect(result.stdout).toBe("ééé")
      expect(result.stdout).not.toContain("�")
      expect(result.stdoutDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)

  it.live.each([
    { printed: "abcdefghij", max: 10, stdout: "abcdefghij", dropped: 0 },
    { printed: "abcdefghijklmnop", max: 10, stdout: "abcde\n[6 bytes omitted]\nlmnop", dropped: 6 },
    // Both cuts split an "é": the head drops its lead byte, the tail skips its
    // continuation byte, and both count as omitted.
    { printed: "é".repeat(9), max: 6, stdout: "é\n[14 bytes omitted]\né", dropped: 14 },
    { printed: `aé${"x".repeat(10)}yz`, max: 6, stdout: "aé\n[9 bytes omitted]\nxyz", dropped: 9 },
    { printed: `ab€${"x".repeat(10)}yz`, max: 6, stdout: "ab\n[12 bytes omitted]\nxyz", dropped: 12 },
    { printed: `a€${"x".repeat(10)}yz`, max: 6, stdout: "a\n[12 bytes omitted]\nxyz", dropped: 12 },
    { printed: `🙂${"x".repeat(10)}yz`, max: 6, stdout: "[13 bytes omitted]\nxyz", dropped: 13 },
    { printed: `🙂${"x".repeat(10)}yz`, max: 8, stdout: "🙂\n[8 bytes omitted]\nxxyz", dropped: 8 },
    { printed: `ab\n${"x".repeat(10)}yz`, max: 6, stdout: "ab\n[9 bytes omitted]\nxyz", dropped: 9 }
  ])(
    "keeps both ends of $printed within $max bytes under overflow ends",
    ({ printed, max, stdout, dropped }) =>
      Effect.gen(function*() {
        const result = yield* Exec.exec(print(printed), { maxCaptureBytes: max, overflow: "ends" })
        expect(result.stdout).toBe(stdout)
        expect(result.stdout).not.toContain("\uFFFD")
        expect(result.stdoutDroppedBytes).toBe(dropped)
      }).pipe(Effect.provide(host)),
    30_000
  )

  it.live("bounds stderr on the same terms as stdout", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stderr.write('abcdefghijklmnop')"`,
        { maxCaptureBytes: 4 }
      )
      expect(result.stderr).toBe("mnop")
      expect(result.stderrDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)
})

describe("Exec refuses partial capture", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it.live(`refuses overflowing ${stream}`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Exec.exec(process.execPath, {
          args: ["-e", `process.${stream}.write('abcde')`],
          maxCaptureBytes: 4,
          overflow: "refuse"
        }))
        expect(error.code).toBe("capture_overflow")
        expect(error.message).toContain(stream)
      }).pipe(Effect.provide(host)))
  }

  it.live("accepts exactly the bound in both streams", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(process.execPath, {
        args: ["-e", "process.stdout.write('éé'); process.stderr.write('abcd')"],
        maxCaptureBytes: 4,
        overflow: "refuse"
      })
      expect(result).toMatchObject({ stdout: "éé", stderr: "abcd", stdoutDroppedBytes: 0, stderrDroppedBytes: 0 })
    }).pipe(Effect.provide(host)))
})

/**
 * A command that never produced an exit code becomes one of two model-facing
 * failures, and the three shell flows have to agree on which. `Exec.exec`
 * fails with a typed `ExecError`, so the choice is a switch on its code rather
 * than a duck-typed read of an `unknown`.
 */
describe("Exec.toStdError", () => {
  it("keeps a timeout's own code and limit and names the command", () => {
    const error = new Exec.ExecError({ code: "timeout", message: "exec: `pytest -q` exceeded 5ms", limitMillis: 5 })
    expect(Exec.toStdError("pytest -q", error)).toMatchObject({
      code: "timeout",
      message: "Command timed out: pytest -q",
      limitMillis: 5
    })
  })

  for (const code of ["spawn_error", "capture_overflow"] as const) {
    it(`reports ${code} as a host failure carrying the exec message`, () => {
      const error = new Exec.ExecError({ code, message: "boom" })
      expect(Exec.toStdError("pytest -q", error)).toMatchObject({
        code: "command_failed",
        message: "Command failed to start: boom"
      })
    })
  }

  it("reports arguments too long to start as the caller's input, with its reason and none of the command", () => {
    const error = new Exec.ExecError({ code: "arguments_too_long", message: "Command not started: too long." })
    const reported = Exec.toStdError("python3 - SYNTHETIC_ARGUMENT", error)
    expect(reported).toMatchObject({ code: "invalid_input", message: "Command not started: too long." })
    expect(reported.message).not.toContain("SYNTHETIC_ARGUMENT")
  })

  for (
    const { code, expected } of [
      { code: "timeout", expected: "timeout" },
      { code: "spawn_error", expected: "command_failed" },
      { code: "arguments_too_long", expected: "invalid_input" },
      { code: "capture_overflow", expected: "command_failed" }
    ] as const
  ) {
    it(`classifies ${code} as ${expected}`, () => {
      expect(Exec.toStdErrorCode(new Exec.ExecError({ code, message: "boom" }))).toBe(expected)
    })
  }
})

/**
 * A spawn the operating system refused, as the production spawner reports it:
 * a platform error whose cause is Node's own, carrying the errno and a message
 * that repeats the command line.
 */
describe("Exec.exec spawn refusals", () => {
  const refusing = (code: string) =>
    ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.fail(PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: CommandLine.render(command),
          description: `spawn ${code}`,
          cause: Object.assign(new Error(`spawn ${code}`), { code, syscall: "spawn" })
        }))
    })
  const refused = (code: string) =>
    Exec.exec("python3", { args: ["-", "SYNTHETIC_ARGUMENT"] }).pipe(
      Effect.flip,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusing(code))
    )

  it.effect("names arguments too long to start, and how to send them, without repeating them", () =>
    Effect.gen(function*() {
      const error = yield* refused("E2BIG")
      expect(error).toMatchObject({
        code: "arguments_too_long",
        message:
          "Command not started: its arguments exceed the operating system's size limit (E2BIG). Send long text on standard input or in a file, not in the command line or its arguments."
      })
      expect(error.message).not.toContain("SYNTHETIC_ARGUMENT")
    }))

  it.effect("keeps every other refusal a host failure", () =>
    Effect.gen(function*() {
      expect(yield* refused("EAGAIN")).toMatchObject({ code: "spawn_error" })
    }))

  it.effect("leaves a spawner defect other than E2BIG a defect", () =>
    Effect.gen(function*() {
      const defect = new Error("spawner bug")
      const exit = yield* Exec.exec("python3", { args: ["-"] }).pipe(
        Effect.exit,
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.makeNoop({ spawn: () => Effect.die(defect) })
        )
      )
      expect(exit._tag).toBe("Failure")
      expect(exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined).toBe(defect)
    }))
})

/**
 * Effect's raw Node spawner, which the TUI composes, lets Node's synchronous
 * E2BIG throw escape as a defect that used to end the whole run (#3990).
 */
describe.skipIf(process.platform === "win32")("Exec.exec over the raw Node spawner", () => {
  it.live("names arguments too long to start instead of dying", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(Exec.exec(`echo ${"x".repeat(2 * 1024 * 1024)}`, {}))
      expect(error).toMatchObject({ code: "arguments_too_long" })
      expect(error.message).not.toContain("xxxx")
    }).pipe(Effect.provide(host)))
})
