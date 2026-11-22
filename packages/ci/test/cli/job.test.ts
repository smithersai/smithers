/**
 * `--job`: the replay asked for some CI jobs only. The program hands the ids to the replay, and refuses, in words
 * and with the usage exit code, an id that names no job and what it cannot measure with `--job`.
 */
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import { inProcess } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import { type Outcome, recorder, remove, repository, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** A repository whose justfile's CI is `ci`, which needs `test`, which needs `build`. */
const root = keep(repository(["first"]))

const runIn = async (args: ReadonlyArray<string>): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, parts, sink.service as never, environment)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

/** The request the test replay printed, or nothing when no replay started. */
const requestOf = (stderr: string): Record<string, unknown> | null =>
  JSON.parse(/replay request: (.*)/.exec(stderr)?.[1] ?? "null")

const jobs = "justfile:build, justfile:test, justfile:ci"

describe("--job", () => {
  it("hands the replay the job asked for", async () => {
    const outcome = await runIn(["replay", "--job", "justfile:test", "--commits", "1"])
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(requestOf(outcome.stderr)?.["only"]).toEqual(["justfile:test"])
  })

  it("is given again for each job more, by the default command too", async () => {
    const outcome = await runIn(["--job", "justfile:ci", "--job", "justfile:build", "--commits", "1"])
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(requestOf(outcome.stderr)?.["only"]).toEqual(["justfile:ci", "justfile:build"])
  })

  it("asks for nothing when it is not given: every job is replayed", async () => {
    const outcome = await runIn(["replay", "--commits", "1"])
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(requestOf(outcome.stderr)).not.toHaveProperty("only")
  })

  it("refuses an id that names no job, listing the jobs there are, and replays nothing", async () => {
    const one = await runIn(["replay", "--job", "justfile:nope", "--commits", "1"])
    expect(one.code).toBe(exitCodes.usage)
    expect(one.stderr).toContain(`smithers-ci: --job justfile:nope names no job of this CI; its jobs are ${jobs}`)
    expect(requestOf(one.stderr)).toBeNull()
    const two = await runIn(["--job", "justfile:test", "--job", "a", "--job", "b", "--commits", "1"])
    expect(two.code).toBe(exitCodes.usage)
    expect(two.stderr).toContain(`smithers-ci: --job a, b name no jobs of this CI; its jobs are ${jobs}`)
  })

  it("refuses fast mode, which it does not measure", async () => {
    for (const mode of ["fast", "both"]) {
      const outcome = await runIn(["replay", "--job", "justfile:test", "--mode", mode, "--commits", "1"])
      expect(outcome.code).toBe(exitCodes.usage)
      expect(outcome.stderr).toContain(
        "smithers-ci: --job is not measured with fast mode: give --mode normal, or leave --job out to measure fast mode over every job"
      )
      expect(requestOf(outcome.stderr)).toBeNull()
    }
  })

  it("refuses --targets beside it: each chooses what to replay", async () => {
    const outcome = await runIn(["replay", "--job", "justfile:test", "--targets", "//:ci", "--commits", "1"])
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain(
      "smithers-ci: --job chooses CI jobs, and --targets the targets of a repository that builds with Smithers build: give one"
    )
  })

  it("is no flag of apply, which still writes every job", async () => {
    const outcome = await runIn(["apply", "--check", "--job", "justfile:test"])
    expect(outcome.code).toBe(exitCodes.usage)
    expect(outcome.stderr).toContain("Unrecognized flag: --job in command smithers-ci apply")
  })
})
