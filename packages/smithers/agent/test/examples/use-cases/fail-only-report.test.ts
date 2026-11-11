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
  RunFailed,
  WriteReport
} from "../../../examples/use-cases/fail-only-report.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

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
}

/**
 * An analyzer that calls every non-zero exit notable, from the results it was
 * handed, and a report agent that writes one root cause per command it was
 * handed. `analyzed` holds each analyzer request's results; `reported` each
 * report request's notable commands.
 */
const script = () => {
  const analyzed: Array<ReadonlyArray<Seen>> = []
  const reported: Array<ReadonlyArray<string>> = []
  const answer: Kit.Script = (asked) => {
    const results = /determine if anything is notable:\n\n(.+)\n/.exec(asked)
    if (results !== null) {
      const seen: ReadonlyArray<Seen> = JSON.parse(results[1]!)
      analyzed.push(seen)
      const failing = seen.filter((result) => result.exitCode !== 0)
      return {
        notable: failing.length > 0,
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
      "npx tsc --noEmit": { exitCode: 0 }
    }, ["ruff check ."])
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
    // The command that never ran dropped out; the analyzer read the other two.
    expect(analyzed.map((results) => results.map((result) => result.command))).toEqual([
      ["pytest -q", "npx tsc --noEmit"]
    ])
    expect(reported).toEqual([])
    expect(sink).toEqual({
      status: "quiet",
      destination: "pr-comment",
      summary: "All 2 commands passed — no report needed"
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

it.effect("drops a command whose directory does not exist", () =>
  Effect.gen(function*() {
    const { analyzed, answer } = script()
    const sink = yield* Kit.run(FailOnlyReport, {
      commands: [{ name: "ok", cmd: "echo ready" }],
      directory: join(directory, "missing")
    }, {
      filename: join(directory, "no-directory.sqlite"),
      executionId: "fail-only-report-no-directory",
      script: answer,
      actions: layer
    })

    expect(analyzed).toEqual([[]])
    expect(sink).toEqual({
      status: "quiet",
      destination: "pr-comment",
      summary: "All 0 commands passed — no report needed"
    })
  }))
