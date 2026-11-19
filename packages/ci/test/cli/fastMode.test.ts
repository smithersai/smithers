import * as Effect from "effect/Effect"
import { afterAll, describe, expect, it } from "vitest"
import type { Parts } from "../../src/cli/Cli.vibe"
import { type Host, layer } from "../../src/cli/Host.vibe"
import { parts as onMain } from "../../src/cli/parts.ts"
import * as Preflight from "../../src/cli/Preflight.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import type { Failure } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { unavailable } from "../../src/select/Failure.ts"
import { answeringModel, inProcess, modelLostFor } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import { commit, head, passingJustfile, recorder, remove, repository, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

/** No key and an empty home: this machine can reach no model. */
const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

const words = (code: string) => unavailable({ _tag: "flows/model/ClassifierError", code } as never)

const runIn = async (
  args: ReadonlyArray<string>,
  root: string,
  chosen: Parts<Host>,
  model?: Parameters<typeof inProcess>[7]
) => {
  const sink = recorder()
  const code = await inProcess(args, root, chosen, sink.service as never, environment, undefined, undefined, model)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

/** The test replay, with the real score part, which asks the model. */
const asking: Parts<Host> = { ...parts, score: onMain.score }

describe("fast mode asks for the model before it works", () => {
  describe.each([
    ["the default command", []],
    ["replay", ["replay"]]
  ])("%s", (_name, command) => {
    it.each(["fast", "both"])(
      "exits 4 with one line and runs nothing with --mode %s and no way to reach the model",
      async (mode) => {
        const root = keep(repository())
        const outcome = await runIn([...command, "--mode", mode], root, asking)
        expect(outcome.code).toBe(exitCodes.failed)
        expect(outcome.stdout).toBe("")
        expect(outcome.stderr).toBe(`smithers-ci: ${words("unconfigured")} ${Preflight.withoutTheModel}\n`)
        expect(outcome.stderr).not.toMatch(/judge|scorer|rows|select:/i)
      }
    )
  })

  it("says the model could not be reached when it is configured and does not answer", async () => {
    const outcome = await runIn(["--mode", "both"], keep(repository()), asking, modelLostFor(() => true))
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toBe(`smithers-ci: ${words("unreachable")} ${Preflight.withoutTheModel}\n`)
  })

  it("replays when the model answers", async () => {
    const outcome = await runIn(["--mode", "both", "--commits", "1"], keep(repository()), asking, answeringModel)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stderr).toContain("replay request:")
  })

  it("never asks the model in normal mode", async () => {
    const unasked: Parts<Host> = { ...parts, score: () => Effect.die("the model was asked") }
    expect((await runIn(["--commits", "1"], keep(repository()), unasked)).code).toBe(exitCodes.ok)
  })

  it("reports any other failure of the question as that part's failure", async () => {
    const broken: Failure = { code: "invalid-document", message: "the rows are wrong", part: "select" }
    const outcome = await runIn(["--mode", "fast"], keep(repository()), { ...parts, score: () => Effect.fail(broken) })
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toBe("smithers-ci: select: the rows are wrong\n")
  })
})

describe("a report whose fast mode could not be measured", () => {
  const notMeasured = (extra: Partial<ReplayReport> = {}): Parts<Host> => ({
    ...parts,
    run: (request, given) =>
      Effect.map(
        parts.run(request, given),
        (report) => ({ ...report, fastNotMeasured: words("unreachable"), ...extra })
      )
  })
  const line = `smithers-ci: fast mode was not measured. ${words("unreachable")}\n`

  it("is printed whole, is said again on standard error, and exits 4", async () => {
    const outcome = await runIn(["--mode", "both"], keep(repository()), notMeasured())
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stdout).toContain("3 commits · 0 mismatches")
    expect(outcome.stdout).toContain(`Fast mode was not measured. ${words("unreachable")}`)
    expect(outcome.stderr.endsWith(line)).toBe(true)
  })

  it("carries the reason in --json", async () => {
    const outcome = await runIn(["replay", "--mode", "fast", "--json"], keep(repository()), notMeasured())
    expect(outcome.code).toBe(exitCodes.failed)
    expect(JSON.parse(outcome.stdout).fastNotMeasured).toBe(words("unreachable"))
  })

  it("exits 4 even with a mismatch, which the report still lists", async () => {
    const outcome = await runIn(
      ["--mode", "both"],
      keep(repository(["[mismatch] first"])),
      notMeasured({ mismatches: 1 })
    )
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stdout).toContain("✗ 1 mismatch")
  })
})

describe("a real replay whose model is lost at the second of three commits", () => {
  it("prints the whole normal-mode report and exits 4", async () => {
    // Each commit changes a different kind of file, so each asks the model a new question.
    const root = keep(repository(["first"]))
    commit(root, "a CI that passes here", { justfile: passingJustfile })
    commit(root, "second", { "notes.md": "two\n" })
    commit(root, "third", { "notes.txt": "three\n" })
    const lost = modelLostFor((items) => items.some((item) => item.changedFileExtensions.includes(".md")))
    // The commit before these three has a CI that needs Zig: the count starts from nothing, not from a run of it.
    const outcome = await runIn(["--mode", "both", "--commits", "3", "--cold"], root, onMain, lost)

    expect(outcome.code, outcome.stderr).toBe(exitCodes.failed)
    expect(outcome.stdout).toContain("3 commits · 0 mismatches")
    expect(outcome.stdout).toContain(`Fast mode was not measured. ${words("unreachable")}`)
    expect(outcome.stdout).not.toMatch(/^fast/m)
    const newest = head(root).slice(0, 7)
    expect(outcome.stdout).toContain(newest)
    expect(outcome.stderr).toContain(`smithers-ci: 3/3 ${newest} normal`)
    expect(outcome.stderr).not.toContain(`3/3 ${newest} fast`)
    expect(outcome.stderr.endsWith(`smithers-ci: fast mode was not measured. ${words("unreachable")}\n`)).toBe(true)
  }, 600_000)
})

describe.runIf(process.env["AI_GATEWAY_API_KEY"])("the model, on a machine with a key", () => {
  it("answers the question the program asks before a replay", async () => {
    const scores = await Effect.runPromise(Effect.provide(onMain.score([Preflight.row]), layer(process.env)))
    expect(scores).toHaveLength(1)
    expect(scores[0]!.score).toBeGreaterThanOrEqual(0)
    expect(scores[0]!.score).toBeLessThanOrEqual(1)
  }, 120_000)
})
