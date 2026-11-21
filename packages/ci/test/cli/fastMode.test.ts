import * as Effect from "effect/Effect"
import { readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
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

  it("starts Claude Code with the user's name, which it finds its sign-in under on macOS, and no other variable", async () => {
    // A real `claude` on the path: it writes down two of the variables it was started with and says it is signed out.
    const programs = keep(temporary("claude"))
    writeFileSync(
      join(programs, "claude"),
      [
        "#!/bin/sh",
        "printf '%s|%s\\n' \"${USER-}\" \"${GITHUB_TOKEN-}\" > \"${0%/*}/started-with\"",
        "printf '{\"loggedIn\":false,\"authMethod\":\"none\"}\\n'",
        "exit 1",
        ""
      ].join("\n"),
      { mode: 0o755 }
    )
    const started = {
      HOME: keep(temporary("home")),
      PATH: `${programs}${delimiter}${process.env["PATH"]}`,
      USER: "the-person",
      GITHUB_TOKEN: "another program's"
    }
    const sink = recorder()
    const code = await inProcess(["--mode", "fast"], keep(repository()), asking, sink.service as never, started)
    expect(code).toBe(exitCodes.failed)
    expect(sink.stderr()).toBe(`smithers-ci: ${words("unconfigured")} ${Preflight.withoutTheModel}\n`)
    expect(readFileSync(join(programs, "started-with"), "utf8")).toBe("the-person|\n")
  })

  it("says the model could not be reached when it is configured and does not answer", async () => {
    const outcome = await runIn(["--mode", "both"], keep(repository()), asking, modelLostFor(() => true))
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stderr).toBe(`smithers-ci: ${words("unreachable")} ${Preflight.withoutTheModel}\n`)
  })

  it("replays when the model answers", async () => {
    const outcome = await runIn(
      ["--mode", "both", "--commits", "1", "--no-apply-check"],
      keep(repository()),
      asking,
      answeringModel
    )
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stderr).toContain("replay request:")
  })

  it("never asks the model in normal mode", async () => {
    const unasked: Parts<Host> = { ...parts, score: () => Effect.die("the model was asked") }
    expect((await runIn(["--commits", "1", "--no-apply-check"], keep(repository()), unasked)).code).toBe(exitCodes.ok)
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

describe("a report the disk stopped before its last commit", () => {
  const line = "the replay stopped before the disk filled: the disk that holds /tmp/x has 2 GB free"
  const stopped: Parts<Host> = {
    ...parts,
    run: (request, given) => Effect.map(parts.run(request, given), (report) => ({ ...report, stopped: line }))
  }

  it("is printed whole, is said again on standard error, and exits 4", async () => {
    const outcome = await runIn(["--commits", "1", "--no-apply-check"], keep(repository()), stopped)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(outcome.stdout).toContain("The replay stopped before the disk filled")
    expect(outcome.stderr.endsWith(`smithers-ci: ${line}\n`)).toBe(true)
  })

  it("carries the line in --json", async () => {
    const outcome = await runIn(["replay", "--commits", "1", "--no-apply-check", "--json"], keep(repository()), stopped)
    expect(outcome.code).toBe(exitCodes.failed)
    expect(JSON.parse(outcome.stdout).stopped).toBe(line)
  })
})

describe("a real replay whose model is lost at the second of three commits", () => {
  it("prints the whole normal-mode report and exits 4", async () => {
    // Each commit changes a different kind of file, so each asks the model a new question.
    const root = keep(repository(["first"]))
    // The test recipe reads the notes: a commit that changes them runs it, so the model is asked about it.
    const reading = passingJustfile.replace("test: build\n    true", "test: build\n    cat notes.md")
    expect(reading).not.toBe(passingJustfile)
    commit(root, "a CI that passes here", { justfile: reading, "notes.md": "one\n" })
    commit(root, "second", { "notes.md": "two\n" })
    commit(root, "third", { "notes.txt": "three\n" })
    const lost = modelLostFor((items) => items.some((item) => item.changedFileExtensions.includes(".md")))
    // The commit before these three has a CI that needs Zig: the count starts from nothing, not from a run of it.
    const outcome = await runIn(["--mode", "both", "--commits", "3", "--no-apply-check", "--cold"], root, onMain, lost)

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

describe("a real replay whose model answers every question", () => {
  it("prints fast mode's numbers with their counts, and what the model was asked", async () => {
    const root = keep(repository(["first"]))
    const reading = passingJustfile.replace("test: build\n    true", "test: build\n    cat notes.md")
    commit(root, "a CI that passes here", { justfile: reading, "notes.md": "one\n" })
    commit(root, "second", { "notes.md": "two\n" })
    const args = ["--mode", "both", "--commits", "2", "--no-apply-check", "--cold"]
    const outcome = await runIn(args, root, onMain, answeringModel)

    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    expect(outcome.stdout).toContain("2 commits · 0 mismatches")
    expect(outcome.stdout).toMatch(/^fast mode\nselection rate {2}100% {2}(\d+) of \1 targets?$/m)
    // Each commit changes another kind of file, so each asks one question; the program's first question is not the replay's.
    expect(outcome.stdout).toMatch(/^the model answered 2 questions in \S+( \S+)?, which is in fast mode's times$/m)
    expect(outcome.stdout).toMatch(/^over the commits these times cover, fast mode's runs took /m)
    // Nothing failed, so no recall is printed; nothing was skipped among so few targets, so no list is.
    expect(outcome.stdout).not.toContain("recall")
    expect(outcome.stdout).not.toContain("predicted-safe")
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
