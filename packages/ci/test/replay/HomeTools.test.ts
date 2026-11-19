/**
 * A tool kept under the person's home, and what a step finds of it.
 *
 * A step has a home of its own. A tool that looks for its files under `HOME`
 * finds them there when its own directory is on `PATH`; a tool a program
 * merely starts from another directory of the home is not given, and the
 * failed step says what to do.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure } from "../../src/contract/Parts.ts"
import { ReplayReport, StepFailure } from "../../src/contract/ReplayReport.ts"
import { TargetResult } from "../../src/contract/RunRecord.ts"
import { confine } from "../../src/replay/Confine.vibe"
import { failuresOf, noJobPassed } from "../../src/replay/Failures.ts"
import { couldNotStart, fixesOf, homeOf, namedInStepHome, putOnPath } from "../../src/replay/HomeTools.ts"
import { Options, Progress, run } from "../../src/replay/index.ts"
import { probe } from "../../src/replay/Jail.ts"
import { addRerun } from "../../src/replay/Summary.ts"
import { html, text } from "../../src/report/index.ts"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const made: Array<string> = []
const directory = (name: string): string => {
  const path = mkdtempSync(join(tmpdir(), `replay-home-tools-${name}-`))
  made.push(path)
  return path
}
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const program = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

const fix = "put ~/.local/go/bin on PATH: ~/.local/go/bin/go is in your home directory and not in the step's, "
  + "and a step gets a tool whose own directory is on PATH"

describe("a path a failed step names in its own home", () => {
  const work = "/tmp/smithers-ci-replay-GbXmsS"

  it("is found under the home of a job's machine, of a baseline job and of a way", () => {
    const machine = `${work}/machines/16cc7cf144a7f53c/test.yml-test-unix-go-17-platform-ubuntu-da6e06fd/home`
    expect(
      namedInStepHome(`taskset: failed to execute ${machine}/.local/go/bin/go: No such file or directory`, [work])
    ).toEqual([".local/go/bin/go"])
    expect(namedInStepHome(`sh: 1: exec: ${work}/home/baseline-job-build/b/tool: not found`, [work])).toEqual([
      "b/tool"
    ])
    expect(namedInStepHome(`'${work}/home/normal/.vm/bin/x' is not there`, [work])).toEqual([".vm/bin/x"])
  })

  it("is found once, under each name the replay's directory has", () => {
    const real = `/private${work}`
    const error = `${real}/home/trial/a/b: not found\n${work}/home/trial/a/b: not found\n${work}/home/trial/c: gone`
    expect(namedInStepHome(error, [work, real])).toEqual(["a/b", "c"])
  })

  it("is no path outside a step's home, and none for no text", () => {
    expect(namedInStepHome(`${work}/normal/repo/tool: not found`, [work])).toEqual([])
    expect(namedInStepHome(`${work}/home/normal: not found`, [work])).toEqual([])
    expect(namedInStepHome("/usr/bin/tool: not found", [work])).toEqual([])
    expect(namedInStepHome(undefined, [work])).toEqual([])
  })
})

describe("a command that could not be started", () => {
  it("is a failed result with the exit code a shell gives one, or with none", () => {
    const failed = { status: "failed", exitCode: 127 } as const
    expect(couldNotStart(failed)).toBe(true)
    expect(couldNotStart({ ...failed, exitCode: 126 })).toBe(true)
    expect(couldNotStart({ status: "failed" })).toBe(true)
    expect(couldNotStart({ ...failed, exitCode: 1 })).toBe(false)
    expect(couldNotStart({ status: "ran", exitCode: 127 })).toBe(false)
    expect(couldNotStart({ status: "ran" })).toBe(false)
  })
})

describe("what a person does about a tool a step did not find", () => {
  it("is one line that names the directory to put on PATH", () => {
    expect(putOnPath(".local/go/bin/go")).toBe(fix)
    expect(putOnPath("tool")).toBe(
      "put ~ on PATH: ~/tool is in your home directory and not in the step's, "
        + "and a step gets a tool whose own directory is on PATH"
    )
  })

  it("looks in the home the person's variables name, and nowhere without one", () => {
    expect(homeOf({ HOME: "/home/ada" })).toBe("/home/ada")
    expect(homeOf({})).toBe("/nonexistent/smithers-ci")
  })

  it("is part of a result and of a failure, and optional in both", () => {
    const result = { label: "//:a", status: "failed", key: "", durationMs: 1, error: "not found", exitCode: 127, fix }
    expect(Schema.decodeUnknownSync(TargetResult)(result)).toEqual(result)
    const failure = { step: "ci.yml:build:1", reason: "not found", exitCode: 127, fix }
    expect(Schema.decodeUnknownSync(StepFailure)(failure)).toEqual(failure)
    expect(failuresOf([Schema.decodeUnknownSync(TargetResult)(result)])).toEqual([
      { step: "//:a", reason: "not found", exitCode: 127, fix }
    ])
  })

  it("is said once for the failures of a run, and is gone from a step that passed when it ran again", () => {
    const plain: TargetResult = {
      label: "//:d",
      status: "failed",
      key: "",
      durationMs: 1,
      error: "not found",
      exitCode: 127
    }
    const failed: TargetResult = { ...plain, label: "//:a", fix }
    const other: TargetResult = { ...failed, label: "//:b", fix: putOnPath("b/tool") }
    expect(fixesOf([failed, { ...failed, label: "//:c" }, other, plain])).toEqual([fix, putOnPath("b/tool")])
    const passed = addRerun(failed, { ...failed, status: "ran" })
    expect(passed).toEqual({
      label: "//:a",
      status: "ran",
      key: "",
      durationMs: 1,
      attempts: [{ passed: true, durationMs: 1 }]
    })
    expect(fixesOf([{ ...failed, status: "ran" }, passed])).toEqual([])
  })

  it("is the last line of what the program prints when no job passed", () => {
    const failure = { step: "ci.yml:build:1", command: "go test", reason: "go: not found", exitCode: 127, fix }
    expect(noJobPassed("746ef07a", failure).split("\n").slice(-4)).toEqual([
      "  command  go test",
      "  exit     127",
      "  error    go: not found",
      `  fix      ${fix}`
    ])
  })
})

describe("a failed step with something to do about it, in a report", () => {
  // The contract's own example, with one failed step that says what to do.
  const example = Schema.decodeUnknownSync(ReplayReport)(
    JSON.parse(readFileSync(new URL("../fixtures/replay-report.example.json", import.meta.url), "utf8"))
  )
  const [first] = example.commits
  const failure = { step: "ci.yml:build:1", reason: "go: not found", exitCode: 127, fix }
  const report: ReplayReport = {
    ...example,
    commits: [{ ...first!, baseline: { ...first!.baseline, ok: false, failures: [failure] } }]
  }

  it("is a line under the step in the text", () => {
    const lines = text(report).split("\n")
    const at = lines.findIndex((line) => line.includes("ci.yml:build:1  exit 127: go: not found"))
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe(`  ${fix}`)
  })

  it("is a line under the step on the page", () => {
    expect(html(report)).toMatch(/exit 127: go: not found<\/span><br>put ~\/\.local\/go\/bin on PATH: [^<]+<\/li>/)
  })
})

describe("the links a step's home starts with", () => {
  it("are there on a machine that cannot jail a step: a step has a home of its own there too", async () => {
    const work = directory("work")
    const tool = join(directory("person"), ".vm")
    mkdirSync(tool)
    const asked = () => ({ refusal: "no bubblewrap", homes: [{ path: ".vm", target: tool }] })
    const places = await Effect.runPromise(
      confine(work, asked, () => Effect.void, [], false).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    )
    expect(places.baseline.links).toEqual([{ path: ".vm", target: tool }])
    for (const home of [places.baseline.home, places.normal.home, places.fast.home, places.normal.template]) {
      expect(readlinkSync(join(home, ".vm"))).toBe(tool)
    }
  })

  it("are named by a machine that cannot jail a step, from the tools on PATH", () => {
    const home = directory("person")
    program(join(home, ".vm", "shims", "tool"), "exec \"$HOME/.vm/versions/1/bin/tool\" \"$@\"")
    program(join(home, ".vm", "versions", "1", "bin", "tool"), "echo tool")
    const searchPath = join(home, ".vm", "shims")
    const before = process.env["PATH"]
    // The probe reads the person's `PATH` from this process.
    process.env["PATH"] = searchPath
    const found = probe({ ...ExecSandbox.host({ PATH: searchPath }), home }, () => "no bubblewrap")
    process.env["PATH"] = before
    expect(found).toEqual({ refusal: "no bubblewrap", homes: [{ path: ".vm", target: join(home, ".vm") }] })
  })
})

describe("a step that starts a tool kept in a directory of the home it is not given", () => {
  const far = job("far", "\"$HOME/kept/tool\"")
  const mostFail = [job("ok", "true"), far, job("gone", "\"$HOME/nowhere/tool\""), job("bad", "exit 1")]
  const replayed = async (
    environment: Readonly<Record<string, string | undefined>>,
    jobs: ReadonlyArray<unknown> = mostFail,
    trial = false
  ) => {
    const said: Array<string> = []
    const root = makeSmallRepository(jobs)
    made.push(root)
    const host = Layer.mergeAll(
      Layer.succeed(Options, {
        smthrs: [smthrs],
        reruns: 0,
        prepare: (checkout) => Effect.sync(() => linkTargets(checkout)),
        confine: unconfined,
        environment
      }),
      Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
    )
    const report = await Effect.runPromise(
      run({ root, commits: 1, modes: ["normal"], trial }, parts("")).pipe(
        Effect.provide(Layer.provideMerge(host, NodeServices.layer))
      ) as Effect.Effect<ReplayReport, Failure>
    )
    return { failures: report.commits[0]?.baseline.failures ?? [], said, left: report.notReplayed ?? [] }
  }

  it("fails with what to do, when the person's home has the tool; any other failure says nothing more", async () => {
    const home = directory("person")
    program(join(home, "kept", "tool"), "echo tool")
    const { failures } = await replayed({ HOME: home, PATH: process.env["PATH"] })
    expect(failures.map((failure) => [failure.step, failure.exitCode, failure.fix])).toEqual([
      [expect.stringContaining("far"), 127, putOnPath("kept/tool")],
      [expect.stringContaining("gone"), 127, undefined],
      [expect.stringContaining("bad"), 1, undefined]
    ])
    expect(failures[0]?.reason).toContain("/kept/tool")
  }, 300_000)

  it(
    "says what to do once, after the jobs the first run leaves out, and still replays the job that passes",
    async () => {
      const home = directory("person")
      program(join(home, "kept", "tool"), "echo tool")
      // Most jobs pass, so the replay goes on without the one that fails here.
      const jobs = [job("ok", "true"), job("fine", "true # fine"), job("well", "true # well"), far]
      const { failures, said, left } = await replayed({ HOME: home, PATH: process.env["PATH"] }, jobs, true)
      expect(failures).toEqual([])
      expect(left.map((entry) => entry.job)).toEqual(["far"])
      const fails = said.filter((line) => line.startsWith("fails here: "))
      expect(fails).toHaveLength(1)
      expect(said[said.indexOf(fails[0] as string) + 1]).toBe(putOnPath("kept/tool"))
      expect(said.filter((line) => line === putOnPath("kept/tool"))).toHaveLength(1)
    },
    300_000
  )

  it("says nothing more for a person whose variables name no home", async () => {
    const { failures } = await replayed({ PATH: process.env["PATH"] })
    expect(failures.map((failure) => [failure.exitCode, failure.fix])).toEqual([
      [127, undefined],
      [127, undefined],
      [1, undefined]
    ])
  }, 300_000)
})
