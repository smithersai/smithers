/**
 * Resumed runs and a newly started one, over the leader's store in OPFS: a
 * leader cut off with many runs in flight, then a reload whose tab starts the
 * run its screen waits on.
 *
 * Background steps wait on a completion barrier. Foreground completion must
 * not depend on that barrier, even when more runs await resumption than the
 * background concurrency limit. Latency measurements belong to `pnpm bench`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { afterEach, beforeEach } from "vitest"
import { BrowserRuntime } from "../src/index.ts"
import { resumeConcurrency } from "../src/internal/Engine.ts"
import * as Engines from "./fixtures/Engines.ts"
import { registration, Steps } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"

/** How many background runs the cut-off leader held, as a branch page's summaries were. */
const cutOffRuns = 60

let remove: () => void = () => undefined
beforeEach(() => {
  remove = MemoryOpfs.install()
})
afterEach(() => remove())

/**
 * A leader over OPFS cut off with `cut` runs inside their second step, then
 * the next leader, whose steps record when each label ran and how many `bg-`
 * steps ran at once at most; `bg-` steps wait for the foreground run.
 */
const reload = (cut: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const name = Engines.name()
    const host = (step: (label: string) => Effect.Effect<string>) =>
      BrowserRuntime.layerHost({ name, sqlite: MemorySqlite.build }, registration(step))
    const first = Engines.steps({ block: cut.map((id) => `${id}:two`) })
    const cutOff = yield* Engines.leader(name, host(first.step))
    const engine = yield* Engines.tab(name)
    yield* Effect.forEach(cut, (id) => engine.start(Steps, { executionId: id, payload: { prefix: id } }), {
      concurrency: 8,
      discard: true
    })
    while (cut.some((id) => !first.ran.includes(`${id}:two`))) yield* Effect.sleep("10 millis")
    yield* Engines.close(cutOff)

    const ran: Array<string> = []
    const release = yield* Deferred.make<void>()
    const background = { running: 0, most: 0 }
    const step = (label: string) =>
      Effect.gen(function*() {
        ran.push(label)
        if (!label.startsWith("bg-")) return label
        background.running++
        background.most = Math.max(background.most, background.running)
        yield* Deferred.await(release)
        background.running--
        return label
      })
    yield* Engines.leader(name, host(step))
    // Once the leader answers a request it has listed and begun what it resumes.
    yield* engine.list({ limit: 1 })
    return { engine, ran, background, release: Deferred.succeed(release, undefined) }
  })

const backgroundIds = Array.from({ length: cutOffRuns }, (_, index) => `bg-${index}`)

/**
 * Every cut-off run settles, having run its second and third steps exactly
 * once and not its first, and no more than `resumeConcurrency` of the
 * background runs ever ran at once, whether the leader or the engine's own
 * sweep resumed them.
 */
const completedOnce = (
  { background, engine, ran }: Effect.Success<ReturnType<typeof reload>>,
  ids: ReadonlyArray<string>
) =>
  Effect.gen(function*() {
    for (const id of ids) expect(yield* engine.result(Steps, id)).toEqual(Exit.succeed(`${id}:three`))
    for (const id of ids) {
      expect(ran.filter((label) => label === `${id}:two`)).toHaveLength(1)
      expect(ran.filter((label) => label === `${id}:three`)).toHaveLength(1)
      expect(ran).not.toContain(`${id}:one`)
    }
    expect(background.most).toBe(resumeConcurrency)
  })

describe("BrowserRuntime admission", () => {
  it.live("a run a tab starts after a reload goes ahead of the runs the reload resumed", () =>
    Effect.gen(function*() {
      const reloaded = yield* reload(backgroundIds)
      const { engine, background } = reloaded
      yield* engine.start(Steps, { executionId: "fg", payload: { prefix: "fg" } })
      expect(yield* engine.result(Steps, "fg")).toEqual(Exit.succeed("fg:three"))
      expect(background.running).toBe(resumeConcurrency)
      expect(reloaded.ran.filter((label) => label.startsWith("bg-"))).toHaveLength(resumeConcurrency)
      yield* reloaded.release
      yield* completedOnce(reloaded, backgroundIds)
    }).pipe(Effect.scoped), { timeout: 120_000 })

  it.live(
    "a tab that starts a run the reload resumed drives it at once, ahead of the backlog",
    () =>
      Effect.gen(function*() {
        const reloaded = yield* reload([...backgroundIds, "fg"])
        const { engine, background } = reloaded
        // Starting a run the store holds is a no-op for its payload; it drives the run now.
        yield* engine.start(Steps, { executionId: "fg", payload: { prefix: "fg" } })
        expect(yield* engine.result(Steps, "fg")).toEqual(Exit.succeed("fg:three"))
        expect(background.running).toBe(resumeConcurrency)
        expect(reloaded.ran.filter((label) => label.startsWith("bg-"))).toHaveLength(resumeConcurrency)
        yield* reloaded.release
        yield* completedOnce(reloaded, [...backgroundIds, "fg"])
      }).pipe(Effect.scoped),
    { timeout: 120_000 }
  )
})
