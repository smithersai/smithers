/** The recorder a person chooses, with SMTHRS_OBSERVE_WITH, reaches every run of Smithers build a replay starts. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { recorderOf, recorderRefusal } from "../../src/replay/Environment.ts"
import { Options, run } from "../../src/replay/index.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

describe("the recorder a person chooses", () => {
  it("is handed on as it was set, and nothing is handed on when it is unset or empty", () => {
    expect(recorderOf({ SMTHRS_OBSERVE_WITH: "strace", PATH: "/bin" })).toEqual({ SMTHRS_OBSERVE_WITH: "strace" })
    expect(recorderOf({ SMTHRS_OBSERVE_WITH: "smthrs-observe" })).toEqual({ SMTHRS_OBSERVE_WITH: "smthrs-observe" })
    expect(recorderOf({ PATH: "/bin" })).toEqual({})
    expect(recorderOf({ SMTHRS_OBSERVE_WITH: "" })).toEqual({})
  })

  it("is refused when it names no recorder Smithers build has, and the refusal never repeats the value", () => {
    for (
      const environment of [{}, { SMTHRS_OBSERVE_WITH: "" }, { SMTHRS_OBSERVE_WITH: "strace" }, {
        SMTHRS_OBSERVE_WITH: "smthrs-observe"
      }]
    ) {
      expect(recorderRefusal(environment)).toBeUndefined()
    }
    for (const value of ["STRACE", "ptrace", " strace"]) {
      const refusal = recorderRefusal({ SMTHRS_OBSERVE_WITH: value })
      expect(refusal).toBe("SMTHRS_OBSERVE_WITH must be smthrs-observe or strace, or unset")
    }
  })
})

/** A `smthrs` that writes the recorder it was asked for to its log, then runs the real one. */
const recording = () => {
  const directory = track(mkdtempSync(join(tmpdir(), "recorder-")))
  const command = join(directory, "smthrs")
  writeFileSync(
    command,
    `#!/bin/sh\necho "with=\${SMTHRS_OBSERVE_WITH-unset}" >> ${directory}/log\nexec ${smthrs} "$@"\n`
  )
  chmodSync(command, 0o755)
  return { command, runs: () => readFileSync(join(directory, "log"), "utf8").trim().split("\n") }
}

const replay = (root: string, command: string, environment: Readonly<Record<string, string | undefined>>) =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [command] as const,
          reruns: 0,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined,
          environment
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

describe("a replay", { timeout: 600_000 }, () => {
  it("hands SMTHRS_OBSERVE_WITH to every run of Smithers build, and nothing when the person did not set it", async () => {
    const root = track(makeSmallRepository([job("reads", "sh a.sh")]))
    const chosen = recording()
    const report = await replay(root, chosen.command, { ...process.env, SMTHRS_OBSERVE_WITH: "strace" })
    expect(report.mismatches).toBe(0)
    expect(chosen.runs().length).toBeGreaterThan(0)
    expect(new Set(chosen.runs())).toEqual(new Set(["with=strace"]))
    const { SMTHRS_OBSERVE_WITH: _set, ...unset } = process.env
    const plain = recording()
    await replay(root, plain.command, unset)
    expect(new Set(plain.runs())).toEqual(new Set(["with=unset"]))
  })
})
