/** Steps that stop making progress, in real temporary repositories, run by the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { noProgress } from "../../src/replay/Failures.ts"
import { Options, run } from "../../src/replay/index.vibe"
import { exitStoppingStalled, tableFor, watchFor } from "../../src/replay/Stall.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const base = parts("none") as unknown as ReplayParts<never>

const replay = (root: string, stallMinutes: number, host: Layer.Layer<never, never, never> = options as never) =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"], stallMinutes }, base).pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

/** Blocks on a pipe no process ever writes. */
const blocked = "d=$(mktemp -d) && mkfifo $d/pipe && cat $d/pipe"

describe("the processes of a stalled run", () => {
  it("are left alone when they can no longer be read, and the run is waited for", async () => {
    const stopped: Array<ReadonlyArray<number>> = []
    const code = await Effect.runPromise(
      Effect.gen(function*() {
        const started = yield* watchFor(0.005, tableFor("linux"))
        const watch = {
          ...started,
          table: {
            read: Effect.map(
              Ref.get(started.stalled),
              (stalled) => stalled ? undefined : [{ pid: 7, parent: 1, cpuMs: 0 }, { pid: 8, parent: 7, cpuMs: 0 }]
            ),
            stop: (pids: ReadonlyArray<number>) => Effect.sync(() => void stopped.push(pids))
          }
        }
        const handle = { pid: 7, exitCode: Effect.as(Effect.sleep("2 seconds"), 3) }
        return yield* exitStoppingStalled(handle as never, watch)
      }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<number | undefined, never>
    )
    expect(code).toBe(3)
    expect(stopped).toEqual([[]])
  }, 60_000)
})

describe("a step that stops making progress", () => {
  it("is stopped at the limit and fails with the reason, in the baseline and as a target", async () => {
    const minutes = 0.1
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("stuck", blocked)]))
    const [commit] = (await replay(root, minutes)).commits
    const expected = [{ step: "stuck0", reason: noProgress(minutes), command: blocked }]
    expect(commit?.baseline.failures).toEqual(expected)
    expect(commit?.normal.failures).toEqual(expected)
    expect(commit?.baseline.counts).toMatchObject({ ran: 1, failed: 1 })
    expect(commit?.normal.counts).toMatchObject({ failed: 1 })
    expect(commit?.mismatches).toEqual([])
  }, 600_000)

  it("is left alone while a child it waits for uses the CPU", async () => {
    const busy = "(while :; do :; done) & child=$!; sleep 8; kill $child"
    const root = track(makeSmallRepository([job("busy", busy)]))
    const [commit] = (await replay(root, 0.05)).commits
    expect(commit?.baseline.ok).toBe(true)
    expect(commit?.normal.ok).toBe(true)
  }, 600_000)

  it("is left alone in the baseline while it keeps printing", async () => {
    const talking = "for i in 1 2 3 4 5 6 7 8; do echo $i; sleep 1; done"
    const root = track(makeSmallRepository([job("talks", talking)]))
    const [commit] = (await replay(root, 0.05)).commits
    expect(commit?.baseline.ok).toBe(true)
  }, 600_000)

  it("fails every target of a run that never ends, when nothing can be stopped", async () => {
    const stuck = Layer.succeed(Options, {
      smthrs: [smthrs] as const,
      reruns: 0,
      prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
      confine: unconfined,
      processes: { ...tableFor("linux"), stop: () => Effect.void }
    })
    const minutes = 0.05
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("stuck", blocked)]))
    const [commit] = (await replay(root, minutes, stuck as never)).commits
    // With no run record, nothing says which target had finished.
    expect(commit?.normal.failures?.map((failure) => [failure.step, failure.reason]).sort()).toEqual([
      ["ok0", noProgress(minutes)],
      ["stuck0", noProgress(minutes)]
    ])
  }, 600_000)

  it("is never stopped when its processes cannot be read", async () => {
    const unreadable = Layer.succeed(Options, {
      smthrs: [smthrs] as const,
      reruns: 0,
      prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
      confine: unconfined,
      processes: { ...tableFor("linux"), under: () => Effect.succeed(undefined), read: Effect.succeed(undefined) }
    })
    const root = track(makeSmallRepository([job("waits", "sleep 5")]))
    const [commit] = (await replay(root, 0.02, unreadable as never)).commits
    expect(commit?.baseline.ok).toBe(true)
    expect(commit?.normal.ok).toBe(true)
  }, 600_000)
})
