/** What a wall time holds: the checkout and the run, and nothing only a replay does. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { compiledCode, compiledSource, Options, run } from "../../src/replay/index.ts"
import { job, linkTargets, makeEmptyDirectory, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"
import { hour, jumping } from "./WallClock.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const replay = (moment: "prepare" | "checkout"): Promise<ReplayReport> => {
  const root = makeSmallRepository([job("a", "sh a.sh")])
  created.push(root)
  const chosen = parts("none") as unknown as ReplayParts<never>
  return Effect.runPromise(
    jumping(moment, run({ root, commits: 1, modes: ["normal", "fast"] }, chosen)).pipe(
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<ReplayReport, Failure>
  )
}

describe("a start of smthrs in a copy", () => {
  it(
    "keeps the compiled code of smthrs beside the copy, in the mode's cache directory, and no step sees where",
    async () => {
      const log = join(makeEmptyDirectory(), "seen")
      created.push(dirname(log))
      // A real smthrs behind a script that writes down where Node, and a smthrs run from source, were told to keep
      // compiled code. A mode's temporary directory is empty at every commit, so neither is kept there.
      const command = join(dirname(log), "smthrs")
      writeFileSync(
        command,
        `#!/bin/sh\necho "$NODE_COMPILE_CACHE $VIBELANG_CACHE_DIR" >> ${log}\nexec ${smthrs} "$@"\n`
      )
      chmodSync(command, 0o755)
      // The step passes only when it is not told: in the baseline, and as a target.
      const root = makeSmallRepository([job("a", `test -z "$NODE_COMPILE_CACHE$VIBELANG_CACHE_DIR"`)])
      created.push(root)
      // The script writes outside every copy, so the runs have no jail.
      const host = Layer.succeed(Options, {
        smthrs: [command],
        reruns: 1,
        prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
        confine: unconfined
      })
      const report = await Effect.runPromise(
        run({ root, commits: 1, modes: ["normal", "fast"] }, parts("none") as unknown as ReplayParts<never>).pipe(
          Effect.provide(Layer.provideMerge(host, NodeServices.layer))
        ) as Effect.Effect<ReplayReport, Failure>
      )
      const starts = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
      // Normal mode, the plan fast mode reads, and fast mode: each in its own mode's cache directory, in no copy.
      expect(starts.length).toBeGreaterThanOrEqual(3)
      for (const line of starts) {
        const [node, source] = line.split(" ")
        expect(node).toMatch(new RegExp(`/kept/(normal|fast)/${compiledCode}$`))
        expect(source).toBe(`${node?.slice(0, -compiledCode.length)}${compiledSource}`)
      }
      expect(new Set(starts.map((line) => /\/kept\/(normal|fast)\//.exec(line)?.[1]))).toEqual(
        new Set(["normal", "fast"])
      )
      const commit = report.commits[0]
      expect(commit?.baseline).toMatchObject({ ok: true, counts: { ran: 1 } })
      expect(commit?.normal).toMatchObject({ ok: true, counts: { ran: 1 } })
      expect(commit?.mismatches).toEqual([])
    },
    600_000
  )
})

describe("the wall time of one commit", () => {
  it("leaves out what only a replay does to a copy before the targets run", async () => {
    // The clock jumps an hour while each mode gets its generated workspace file and the package that file imports.
    const commit = (await replay("prepare")).commits[0]
    expect(commit?.normal.wallMs).toBeGreaterThan(0)
    expect(commit?.normal.wallMs).toBeLessThan(hour)
    expect(commit?.fast?.wallMs).toBeLessThan(hour)
    expect(commit?.baseline.wallMs).toBeLessThan(hour)
  }, 600_000)

  it("holds the checkout, in the baseline and in each mode", async () => {
    // The clock jumps an hour at each checkout: one for the baseline's job, one for each mode's copy.
    const commit = (await replay("checkout")).commits[0]
    for (const wallMs of [commit?.baseline.wallMs, commit?.normal.wallMs, commit?.fast?.wallMs]) {
      expect(wallMs).toBeGreaterThanOrEqual(hour)
      expect(wallMs).toBeLessThan(2 * hour)
    }
  }, 600_000)
})
