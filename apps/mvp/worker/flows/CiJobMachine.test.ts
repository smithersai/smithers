// A CI job on the Node host's engine (worker/flows/CiJobMachine.ts, `@smthrs/sandbox`'s `ci/job`): its machine is a
// test `Machines` that records each call and answers each command's exit code from a table, the only stand-in.
import { CiJob, type SandboxTools } from "@smthrs/sandbox"
import { Effect, Exit, Layer } from "effect"
import { describe, expect, test } from "vitest"
import { noCommands } from "../test/commands.ts"
import { Machines } from "../branch/Machines.ts"
import { SandboxUnavailable } from "../branch/Sandboxes.ts"
import { runFlow } from "../test/flowHost.ts"
import * as CiJobMachine from "./CiJobMachine.ts"

const target: CiJob.Target = { run: "ci:delivery-7", repo: "acme/widgets", sha: "b".repeat(40), ref: "refs/heads/main" }

interface Call {
  readonly branch: string
  readonly owner: string
  readonly callId: string
  readonly command: string
}

/**
 * A machine at `head`, whose command `run` exits with `exits[run]` (0 unless set), refuses or loses a command in
 * `lost`, and fails `unavailable` times as a machine that couldn't start before it answers.
 */
const machine = (options: {
  readonly output?: { stdout: string; stderr: string; truncated: boolean }
  readonly head?: string
  readonly exits?: Readonly<Record<string, number>>
  readonly lost?: ReadonlyArray<string>
  readonly unavailable?: number
  readonly unavailableOnce?: ReadonlyArray<string>
} = {}) => {
  const calls: Array<Call> = []
  const sleeps: Array<{ readonly branchId: string; readonly generation: number }> = []
  let unavailable = options.unavailable ?? 0
  const once = new Set(options.unavailableOnce)
  const service = Machines.of({
    commands: () => noCommands,
    tool: (branch, owner, callId, call) => {
      if (unavailable > 0) {
        unavailable -= 1
        return Effect.fail(new SandboxUnavailable({ reason: "start" }))
      }
      const command = (call as typeof SandboxTools.Run.Type).command
      if (once.delete(command)) return Effect.fail(new SandboxUnavailable({ reason: "exec" }))
      calls.push({ branch: JSON.stringify(branch), owner, callId, command })
      if (options.lost?.includes(command) === true) {
        return Effect.fail({ _tag: "@smthrs/sandbox/SandboxTools/ToolLost" } as never)
      }
      const exitCode = command.startsWith("test ") ? (command.endsWith(options.head ?? target.sha) ? 0 : 1) : options.exits?.[command] ?? 0
      return Effect.succeed({
        generation: 3,
        result: {
          tool: "run" as const,
          exitCode,
          timedOut: false,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
          ...options.output,
        },
      })
    },
    sleepIfIdle: (branchId, generation) =>
      Effect.sync(() => {
        sleeps.push({ branchId, generation })
        return "slept" as const
      }),
  })
  return { calls, sleeps, layer: Layer.succeed(Machines, service) }
}

const registration = CiJobMachine.registration

const job = (name: string, ...runs: ReadonlyArray<string>): CiJob.Job => ({
  name,
  steps: runs.map((run, index) => ({ name: `step-${index}`, run })),
})

describe("ci/job on a job machine", { timeout: 60_000 }, () => {
  test("runs on its own job machine at exactly the commit, as the ci user, each call once by its own id", async () => {
    const box = machine()
    const ran = await runFlow(CiJob.CiJob, { target, job: job("build", "node --version", "pnpm --version") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "passed",
      steps: [
        { name: "checkout", outcome: "passed", exitCode: null },
        { name: "step-0", outcome: "passed", exitCode: 0 },
        { name: "step-1", outcome: "passed", exitCode: 0 },
      ],
    }))
    const branch = CiJobMachine.machineOf(target, "build")
    expect(branch).toEqual({
      branchId: expect.stringMatching(/^job-[0-9a-f]{40}$/),
      owner: "acme",
      name: "widgets",
      branch: target.sha,
      forge: "github",
      kind: "job",
    })
    expect(box.calls.map((call) => [call.branch, call.owner, call.command])).toEqual([
      [JSON.stringify(branch), "ci", `test "$(git rev-parse HEAD)" = ${target.sha}`],
      [JSON.stringify(branch), "ci", "node --version"],
      [JSON.stringify(branch), "ci", "pnpm --version"],
      [JSON.stringify(branch), "ci", CiJobMachine.STOP_LEFTOVERS],
    ])
    expect(new Set(box.calls.map((call) => call.callId)).size).toBe(4)
    // Released: put to sleep at the generation the job ran on.
    expect(box.sleeps).toEqual([{ branchId: branch.branchId, generation: 3 }])
  })

  test("each job of a run, and each run, has a machine of its own", () => {
    const ids = [
      CiJobMachine.machineOf(target, "build").branchId,
      CiJobMachine.machineOf(target, "lint").branchId,
      CiJobMachine.machineOf({ ...target, run: "ci:delivery-8" }, "build").branchId,
    ]
    expect(new Set(ids).size).toBe(3)
  })

  test("a machine at another commit runs no step", async () => {
    const box = machine({ head: "c".repeat(40) })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("build", "make") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "failed",
      steps: [
        { name: "checkout", outcome: "failed", exitCode: null },
        { name: "step-0", outcome: "skipped", exitCode: null },
      ],
    }))
    expect(box.calls.map((call) => call.command)).not.toContain("make")
  })

  test("a checkout the machine lost runs no step", async () => {
    const box = machine({ lost: [`test "$(git rev-parse HEAD)" = ${target.sha}`] })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("build", "make") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "failed",
      steps: [
        { name: "checkout", outcome: "failed", exitCode: null },
        { name: "step-0", outcome: "skipped", exitCode: null },
      ],
    }))
  })

  test("a step whose machine didn't answer is tried again, and runs once it does", async () => {
    const box = machine({ unavailableOnce: ["pnpm test"] })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("test", "pnpm test") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "passed",
      steps: [
        { name: "checkout", outcome: "passed", exitCode: null },
        { name: "step-0", outcome: "passed", exitCode: 0 },
      ],
    }))
    expect(box.calls.filter((call) => call.command === "pnpm test")).toHaveLength(1)
  })

  test("a step the machine lost fails, and is never run again", async () => {
    const box = machine({ lost: ["pnpm test"] })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("test", "pnpm test", "pnpm lint") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "failed",
      steps: [
        { name: "checkout", outcome: "passed", exitCode: null },
        { name: "step-0", outcome: "failed", exitCode: CiJobMachine.LOST_EXIT_CODE },
        { name: "step-1", outcome: "skipped", exitCode: null },
      ],
    }))
    expect(box.calls.filter((call) => call.command === "pnpm test")).toHaveLength(1)
  })

  test("a machine that couldn't start is tried again, and the job runs once it does", async () => {
    const box = machine({ unavailable: 1, exits: { "exit 1": 1 } })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("broken", "exit 1") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({
      outcome: "failed",
      steps: [
        { name: "checkout", outcome: "passed", exitCode: null },
        { name: "step-0", outcome: "failed", exitCode: 1 },
      ],
    }))
  })
})

test("CI adapter retains bounded command output in the step result", async () => {
  for (const output of [
    { stdout: "v26\n", stderr: "", truncated: false },
    { stdout: "", stderr: "warning\n", truncated: false },
    { stdout: "", stderr: "", truncated: true },
  ]) {
    const box = machine({ output })
    const ran = await runFlow(CiJob.CiJob, { target, job: job("output", "node") }, registration(box.layer))
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "passed", steps: [
      { name: "checkout", outcome: "passed", exitCode: null },
      { name: "step-0", outcome: "passed", exitCode: 0, output },
    ] }))
  }
}, 60_000)
