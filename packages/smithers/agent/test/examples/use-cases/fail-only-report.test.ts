import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Analyze,
  FailOnlyReport,
  layer,
  RunCommand,
  runCommand,
  RunFailed,
  WriteReport
} from "../../../examples/use-cases/fail-only-report.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "fail-only-report-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

interface Outcome {
  readonly exitCode: number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * A runner that answers each command with `outcomes[cmd]` and fails the ones
 * in `broken`, recording what it was handed. It replaces the host runner, so
 * no command runs.
 */
const runner = (outcomes: Record<string, Outcome>, broken: ReadonlyArray<string> = []) => {
  const ran: Array<string> = []
  const actions = Layer.mergeAll(
    RunCommand.toLayer(({ command, directory, timeoutMs }) => {
      ran.push(`${command} in ${directory} within ${timeoutMs}`)
      if (broken.includes(command)) return Effect.fail(new RunFailed({ command, message: "spawn ENOENT" }))
      const { exitCode, stderr = "", stdout = "" } = outcomes[command]!
      return Effect.succeed({ command, exitCode, stdout, stderr, durationMs: 40 })
    }),
    Analyze.layer,
    WriteReport.layer
  )
  return { actions, ran }
}

interface Seen {
  readonly command: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/**
 * An analyzer that calls every non-zero exit notable, from the results it was
 * handed, and a report agent that writes one root cause per command it was
 * handed. `analyzed` holds each analyzer request's results; `reported` each
 * report request's notable commands.
 */
const script = ({ quiet = false }: { readonly quiet?: boolean } = {}) => {
  const analyzed: Array<ReadonlyArray<Seen>> = []
  const reported: Array<ReadonlyArray<string>> = []
  const answer: Kit.Script = (asked) => {
    const results = /determine if anything is notable:\n\n(.+)\n/.exec(asked)
    if (results !== null) {
      const seen: ReadonlyArray<Seen> = JSON.parse(results[1]!)
      analyzed.push(seen)
      const failing = seen.filter((result) => result.exitCode !== 0)
      return {
        notable: !quiet && failing.length > 0,
        failingCommands: failing.map((result) => result.command),
        regressingCommands: [],
        artifacts: failing.map((result) => ({ command: result.command, category: "failure", snippet: result.stderr })),
        // Saying a named command failed is what the step's `claimCap: 0` is
        // for: the completion brake would refuse it as unrecorded work.
        summary: failing.map((result) => `${result.command} failed`).join("; ")
      }
    }
    const notable = /\nNotable commands: (.+)\n/.exec(asked)
    if (notable !== null) {
      const commands: ReadonlyArray<string> = JSON.parse(notable[1]!)
      reported.push(commands)
      return {
        rootCauses: commands.map((command) => ({
          command,
          hypothesis: `${command} fails because the fixture totals changed`,
          confidence: "medium",
          suggestedFix: "refresh the fixture"
        })),
        overallSummary: `Root causes for ${commands.join(", ")}`,
        sinkPayload: commands.join("\n")
      }
    }
    return undefined
  }
  return { analyzed, answer, reported }
}

it.effect("reports a failing command and keeps a passing one out of the report", () =>
  Effect.gen(function*() {
    const { actions, ran } = runner({
      "pytest -q": { exitCode: 1, stderr: "E   AssertionError: totals differ" },
      "ruff check .": { exitCode: 0, stdout: "x".repeat(5_000) }
    })
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [{ name: "unit", cmd: "pytest -q" }, { name: "lint", cmd: "ruff check ." }],
      directory: "service",
      timeoutMs: 1_000,
      sink: "slack"
    }, {
      filename: join(directory, "notable.sqlite"),
      executionId: "fail-only-report-notable",
      script: answer,
      actions
    })

    expect(ran).toEqual(["pytest -q in service within 1000", "ruff check . in service within 1000"])
    // The analyzer read both results, each output cut to 2,000 characters.
    expect(analyzed).toHaveLength(1)
    expect(analyzed[0]!.map((result) => [result.command, result.exitCode, result.stdout.length])).toEqual([
      ["pytest -q", 1, 0],
      ["ruff check .", 0, 2_000]
    ])
    // Only the notable command reached the report agent.
    expect(reported).toEqual([["pytest -q"]])
    expect(sink).toEqual({ status: "reported", destination: "slack", summary: "Root causes for pytest -q" })
  }))

it.effect("settles quietly without a report when every command passes", () =>
  Effect.gen(function*() {
    const { actions, ran } = runner({
      "pytest -q": { exitCode: 0 },
      "npx tsc --noEmit": { exitCode: 0 },
      "ruff check .": { exitCode: 0 }
    })
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, {}, {
      filename: join(directory, "quiet.sqlite"),
      executionId: "fail-only-report-quiet",
      script: answer,
      actions
    })

    // The default commands ran in the current directory within five minutes.
    expect(ran).toEqual([
      "pytest -q in . within 300000",
      "ruff check . in . within 300000",
      "npx tsc --noEmit in . within 300000"
    ])
    // The analyzer sees every requested command.
    expect(analyzed.map((results) => results.map((result) => result.command))).toEqual([
      ["pytest -q", "ruff check .", "npx tsc --noEmit"]
    ])
    expect(reported).toEqual([])
    expect(sink).toEqual({
      status: "quiet",
      destination: "pr-comment",
      summary: "All 3 commands passed — no report needed"
    })
  }))

it.effect("runs real commands, reporting exit codes and timeouts as results", () =>
  Effect.gen(function*() {
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [
        { name: "ok", cmd: "echo ready" },
        { name: "bad", cmd: "echo boom >&2; exit 3" },
        { name: "slow", cmd: "sleep 5" }
      ],
      directory,
      timeoutMs: 500
    }, {
      filename: join(directory, "real.sqlite"),
      executionId: "fail-only-report-real",
      script: answer,
      actions: layer
    })

    expect(analyzed).toHaveLength(1)
    const seen = analyzed[0]!.map(({ command, exitCode, stderr, stdout }) => ({ command, exitCode, stdout, stderr }))
    expect(seen).toEqual([
      { command: "echo ready", exitCode: 0, stdout: "ready\n", stderr: "" },
      { command: "echo boom >&2; exit 3", exitCode: 3, stdout: "", stderr: "boom\n" },
      { command: "sleep 5", exitCode: 124, stdout: "", stderr: "Timed out after 500 ms" }
    ])
    expect(reported).toEqual([["echo boom >&2; exit 3", "sleep 5"]])
    expect(sink.status).toBe("reported")
  }))

it.effect("reports runner failures alongside successful commands", () =>
  Effect.gen(function*() {
    const { actions, ran } = runner({ "echo ready": { exitCode: 0 } }, ["cannot start"])
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [{ name: "ok", cmd: "echo ready" }, { name: "broken", cmd: "cannot start" }]
    }, {
      filename: join(directory, "runner-failure.sqlite"),
      executionId: "fail-only-report-runner-failure",
      script: answer,
      actions
    })

    expect(ran).toHaveLength(2)
    expect(analyzed[0]!.map(({ command, exitCode, stderr }) => ({ command, exitCode, stderr }))).toEqual([
      { command: "echo ready", exitCode: 0, stderr: "" },
      { command: "cannot start", exitCode: 125, stderr: "spawn ENOENT" }
    ])
    expect(reported).toEqual([["cannot start"]])
    expect(sink).toEqual({
      status: "reported",
      destination: "pr-comment",
      summary: "Root causes for cannot start"
    })
  }))

it.effect("reports every command when its directory does not exist", () =>
  Effect.gen(function*() {
    const { analyzed, answer, reported } = script()
    const commands = [{ name: "ok", cmd: "echo ready" }, { name: "also-ok", cmd: "echo done" }]
    const sink = yield* Kit.run(FailOnlyReport, {
      commands,
      directory: join(directory, "missing")
    }, {
      filename: join(directory, "no-directory.sqlite"),
      executionId: "fail-only-report-no-directory",
      script: answer,
      actions: layer
    })

    expect(analyzed).toHaveLength(1)
    expect(analyzed[0]!.map(({ command, exitCode }) => ({ command, exitCode }))).toEqual(
      commands.map(({ cmd }) => ({ command: cmd, exitCode: 125 }))
    )
    for (const result of analyzed[0]!) expect(result.stderr).toContain("ENOENT")
    expect(reported).toEqual([commands.map(({ cmd }) => cmd)])
    expect(sink.status).toBe("reported")
  }))

for (
  const { name, cmd, diagnostic } of [
    {
      name: "signal",
      cmd: "echo before; printf '%03000d' 0 >&2; kill -KILL $$",
      diagnostic: "SIGKILL"
    },
    {
      name: "stdout-overflow",
      cmd: `node -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'`,
      diagnostic: "maxBuffer"
    },
    {
      name: "stderr-overflow",
      cmd: `node -e 'process.stderr.write("x".repeat(2 * 1024 * 1024))'`,
      diagnostic: "maxBuffer"
    }
  ]
) {
  it.effect(`reports ${name} instead of claiming the remaining command passed`, () =>
    Effect.gen(function*() {
      const { analyzed, answer, reported } = script()
      const sink = yield* Kit.run(FailOnlyReport, {
        commands: [{ name: "ok", cmd: "echo ready" }, { name, cmd }],
        directory,
        timeoutMs: 10_000
      }, {
        filename: join(directory, `${name}.sqlite`),
        executionId: `fail-only-report-${name}`,
        script: answer,
        actions: layer
      })

      expect(analyzed).toHaveLength(1)
      expect(analyzed[0]!.map(({ command, exitCode }) => ({ command, exitCode }))).toEqual([
        { command: "echo ready", exitCode: 0 },
        { command: cmd, exitCode: 125 }
      ])
      const failed = analyzed[0]![1]!
      expect(failed.stderr).toContain(diagnostic)
      if (name === "signal") {
        expect(failed.stdout).toBe("before\n")
        expect(failed.stderr.startsWith("Signal SIGKILL: ")).toBe(true)
        expect(failed.stderr).toContain("0".repeat(1_000))
      } else if (name === "stdout-overflow") {
        expect(failed.stdout).toBe("x".repeat(2_000))
      } else {
        expect(failed.stderr).toContain("x".repeat(1_000))
      }
      expect(reported).toEqual([[cmd]])
      expect(sink.status).toBe("reported")
    }))
}

it.effect("settles an explicitly empty command list without inventing results", () =>
  Effect.gen(function*() {
    const { actions, ran } = runner({})
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, { commands: [] }, {
      filename: join(directory, "empty.sqlite"),
      executionId: "fail-only-report-empty",
      script: answer,
      actions
    })

    expect(ran).toEqual([])
    expect(analyzed).toEqual([[]])
    expect(reported).toEqual([])
    expect(sink).toEqual({
      status: "quiet",
      destination: "pr-comment",
      summary: "All 0 commands passed — no report needed"
    })
  }))

it.effect("does not claim commands passed when the analyzer overlooks a runner failure", () =>
  Effect.gen(function*() {
    const { actions } = runner({ "echo ready": { exitCode: 0 } }, ["cannot start"])
    const { analyzed, answer, reported } = script({ quiet: true })
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [{ name: "ok", cmd: "echo ready" }, { name: "broken", cmd: "cannot start" }]
    }, {
      filename: join(directory, "overlooked-failure.sqlite"),
      executionId: "fail-only-report-overlooked-failure",
      script: answer,
      actions
    })

    expect(analyzed[0]!.map(({ exitCode }) => exitCode)).toEqual([0, 125])
    expect(reported).toEqual([])
    expect(sink).toEqual({
      status: "quiet",
      destination: "pr-comment",
      summary: "Not all 2 commands passed — no report requested"
    })
  }))

it.effect("retains captured output and measured duration from a runner failure", () =>
  Effect.gen(function*() {
    const actions = Layer.mergeAll(
      RunCommand.toLayer(({ command }) =>
        Effect.fail(
          new RunFailed({
            command,
            message: "runner stopped",
            stdout: "partial stdout",
            stderr: "partial stderr",
            durationMs: 137
          })
        )
      ),
      Analyze.layer,
      WriteReport.layer
    )
    const { analyzed, answer, reported } = script()
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [{ name: "broken", cmd: "cannot finish" }]
    }, {
      filename: join(directory, "runner-diagnostics.sqlite"),
      executionId: "fail-only-report-runner-diagnostics",
      script: answer,
      actions
    })

    expect(analyzed).toEqual([[
      {
        command: "cannot finish",
        exitCode: 125,
        stdout: "partial stdout",
        stderr: "runner stopped\npartial stderr",
        durationMs: 137
      }
    ]])
    expect(reported).toEqual([["cannot finish"]])
    expect(sink.status).toBe("reported")
  }))

it.effect("records signal output once while keeping the diagnostic separate", () =>
  Effect.gen(function*() {
    const command = "echo before; printf '%03000d' 0 >&2; kill -KILL $$"
    const failure = yield* Effect.flip(runCommand({ command, directory, timeoutMs: 10_000 }))

    expect(failure.command).toBe(command)
    expect(failure.message).toBe(`Signal SIGKILL: ${command}`)
    expect(failure.stdout).toBe("before\n")
    expect(failure.stderr).toBe("0".repeat(3_000))
    expect(failure.durationMs).toBeGreaterThanOrEqual(0)
  }))
