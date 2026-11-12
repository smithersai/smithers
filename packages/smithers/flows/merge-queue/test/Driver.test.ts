import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import type { Config, Part, State, Tree } from "../src/index.ts"
import { Driver, empty, QueueSchema, run, sameTree, strip, TargetDiverged, Unavailable } from "../src/index.ts"
import { random } from "./support/Generate.ts"
import { steps } from "./support/Theorems.ts"
import type { Script, World } from "./support/World.ts"
import { makeWorld, statusesOf, wholeTree } from "./support/World.ts"

const config: Config = { required: [1, 2], maxAttempts: 2, maxBatch: 4, maxRuns: 2, window: 5, defaultDuration: 60 }

const start: Driver.Position = { state: empty, cursor: 0, closed: false, ended: [], settled: 0 }

const statuses = statusesOf

const show = (tree: ReadonlyArray<Part>): ReadonlyArray<string> => tree.map((entry) => `${entry.id}.${entry.rev}`)

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

const round = (settings: Config, world: World, position: Driver.Position): Promise<Driver.Outcome> =>
  Effect.runPromise(Driver.round(settings, position).pipe(Effect.provide(world.layer)))

const roundExit = (settings: Config, world: World, position: Driver.Position) =>
  Effect.runPromiseExit(Driver.round(settings, position).pipe(Effect.provide(world.layer)))

/** Rounds until the state satisfies `reached`. */
const until = async (
  world: World,
  from: Driver.Position,
  reached: (outcome: Driver.Outcome) => boolean,
  settings: Config = config
): Promise<Driver.Outcome> => {
  let position = from
  for (let rounds = 0; rounds < 400; rounds++) {
    const outcome = await round(settings, world, position)
    if (reached(outcome)) return outcome
    position = outcome
  }
  throw new Error("not reached in 400 rounds")
}

const drain = (world: World, from: Driver.Position = start, settings: Config = config): Promise<Driver.Outcome> =>
  until(world, from, (outcome) => outcome.done, settings)

/** Starts a round that will wait for the world, lets it sync, acts, and returns its outcome. */
const during = async (world: World, position: Driver.Position, act: () => void): Promise<Driver.Outcome> => {
  const pending = round(config, world, position)
  await tick()
  act()
  return pending
}

/**
 * The ground truth, read from the world and not from the queue:
 * the target only ever fast-forwards, and every tree the queue put there is
 * exactly a tree CI tested, complete and green.
 */
const expectSound = (world: World, settings: Config = config): void => {
  for (let index = 1; index < world.targets.length; index++) {
    expect(strip(world.targets[index - 1]!, world.targets[index]!)).toBeDefined()
  }
  for (const tree of world.pushed) {
    const tested = [...world.runs.values()].filter((record) => sameTree(record.tree, tree))
    expect(
      tested.some((record) =>
        settings.required.every((check) =>
          record.finished.some((entry) => entry.check === check && entry.verdict === "pass")
        ) && record.finished.every((entry) => entry.verdict === "pass")
      )
    ).toBe(true)
    expect(world.passes(tree)).toBe(true)
  }
}

/**
 * The record against the ground truth of the world, once the queue is done.
 * It holds every change that was handed in and every foreign commit, once. A
 * change is recorded as merged exactly when the target holds it, at the
 * revision it holds, as foreign exactly when the queue did not push it, and
 * with the results of a complete green run when the queue did. An unmergeable
 * change has written words. The queue's own state holds none of them.
 */
const expectRecorded = (world: World, end: Driver.Position, settings: Config = config, context = ""): void => {
  const ids = world.endings.map((ending) => ending.id)
  expect(new Set(ids).size, context).toBe(ids.length)
  expect([...ids].sort((a, b) => a - b), context).toEqual([...world.known()].sort((a, b) => a - b))
  expect(end.state.changes, context).toEqual([])
  expect(end.state.landed, context).toEqual([])
  const target = world.targets.at(-1)!
  // What the queue itself put on the target: the parts each of its pushes added to the tree before it.
  const pushed = new Set(
    world.targets.flatMap((tree, index) =>
      index > 0 && world.pushed.some((other) => sameTree(other, tree))
        ? tree.slice(world.targets[index - 1]!.length).map((entry) => `${entry.id}.${entry.rev}`)
        : []
    )
  )
  expect(
    world.endings.filter((ending) => ending.status._tag === "merged").map((ending) => `${ending.id}.${ending.rev}`)
      .sort(),
    context
  ).toEqual(target.map((entry) => `${entry.id}.${entry.rev}`).sort())
  for (const ending of world.endings) {
    if (ending.status._tag === "merged") {
      const queued = pushed.has(`${ending.id}.${ending.rev}`)
      expect(ending.landing?.foreign, context).toBe(!queued)
      if (queued) {
        expect(
          settings.required.every((check) =>
            ending.landing!.results.some((result) => result.check === check && result.verdict === "pass")
          ) && ending.landing!.results.every((result) => result.verdict === "pass"),
          context
        ).toBe(true)
      }
    } else {
      expect(ending.landing, context).toBeNull()
      if (ending.status._tag === "unmergeable") expect(ending.status.reason.detail, context).not.toBe("")
    }
  }
}

/** Change 3 fails check 2 until it is fixed once. */
const threeIsBroken: Script = {
  failing: (entry) => entry.id === 3 && entry.rev === 0 ? [2] : [],
  fix: () => ({ _tag: "fixed" })
}

describe("landing", () => {
  it("lands passing changes in order, each as a fast-forward onto a tested tree", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.enqueue(2, 5)
    world.close()
    const end = await drain(world)
    expect(statuses(world, end)).toEqual({ 1: "merged", 2: "merged" })
    expect(show(world.targets.at(-1)!)).toEqual(["2.0", "1.0"])
    expect(world.log).toContain("target.advance  -> 2.0,1.0")
    expectSound(world)
  })

  it("finishes at once when closed with nothing queued", async () => {
    const world = makeWorld(config)
    world.close()
    const end = await drain(world)
    expect(end.state).toEqual(empty)
    expect(world.log).toEqual([])
    expect((await round(config, world, end)).done).toBe(true)
  })

  it("bisects a failing batch, has the culprit fixed, and lands everything", async () => {
    const world = makeWorld(config, threeIsBroken)
    for (const id of [1, 2, 3, 4]) world.enqueue(id)
    world.close()
    const end = await drain(world)
    expect(statuses(world, end)).toEqual({ 1: "merged", 2: "merged", 3: "merged", 4: "merged" })
    expect(world.endings.find((ending) => ending.id === 3)).toMatchObject({ rev: 1, attempts: 1 })
    expect([...show(world.targets.at(-1)!)].sort()).toEqual(["1.0", "2.0", "3.1", "4.0"])
    expect(world.briefs[0]).toMatchObject({ id: 3, rev: 0, attempt: 1, failures: [2] })
    expectSound(world)
  })
})

describe("unmergeable", () => {
  it("puts a change out with the agent's words when the agent gives up", async () => {
    const world = makeWorld(config, {
      failing: (entry) => entry.id === 1 ? [1] : [],
      fix: () => ({ _tag: "gaveUp", detail: "conflicts with the new parser; redo it" })
    })
    world.enqueue(1)
    world.enqueue(2)
    world.close()
    const end = await drain(world)
    expect(world.endings.find((ending) => ending.id === 1)!.status).toMatchObject({
      _tag: "unmergeable",
      reason: { kind: "agentVerdict", detail: "conflicts with the new parser; redo it", failures: [1] }
    })
    expect(statuses(world, end)[2]).toBe("merged")
    expectSound(world)
  })

  it("puts a change out when its fixes keep failing and no attempt is left", async () => {
    const world = makeWorld(config, { failing: (entry) => entry.id === 1 ? [2] : [], fix: () => ({ _tag: "fixed" }) })
    world.enqueue(1)
    world.close()
    await drain(world)
    expect(world.endings[0]).toMatchObject({
      id: 1,
      attempts: 2,
      rev: 2,
      status: { _tag: "unmergeable", reason: { kind: "attemptsExhausted", failures: [2], attempts: 2 } }
    })
    expect(world.targets).toEqual([[]])
  })
})

describe("streaming", () => {
  it("starts the fix at the first failed check and passes later failures on", async () => {
    const world = makeWorld(config, {
      auto: false,
      failing: (entry) => entry.id === 1 && entry.rev === 0 ? [1, 2] : []
    })
    world.enqueue(1)
    let position: Driver.Position = await round(config, world, start)
    position = await during(world, position, () => {
      expect(world.runs.get(0)!.job).toMatchObject({ tree: [{ id: 1, rev: 0 }], checks: [1, 2], eta: 60 })
      world.finish(0)
    })
    expect(statuses(world, position)).toEqual({ 1: "fixing" })
    expect(world.runs.get(0)!.waiting).toEqual([2])
    position = await during(world, position, () => {
      expect(world.log).toContain("fixer.brief 1#1 failures=1")
      world.finish(0)
    })
    position = await during(world, position, () => {
      expect(world.log.at(-1)).toBe("fixer.brief 1#1 failures=1+2")
      world.answer(1, 1, { _tag: "fixed" })
      world.close()
    })
    position = await during(world, position, () => {
      expect(world.log).toContain("ci.stop 0")
      expect(world.log).toContain("fixer.stop 1#1")
      world.finish(1, 2)
    })
    const end = await drain(world, position)
    expect(statuses(world, end)).toEqual({ 1: "merged" })
    expectSound(world)
  })

  it("never lands on a partial result", async () => {
    const world = makeWorld(config, { auto: false })
    world.enqueue(1)
    let position: Driver.Position = await round(config, world, start)
    position = await during(world, position, () => world.finish(0))
    expect(position.state.runs[0]!.results).toEqual([{ check: 1, verdict: "pass" }])
    expect(position.state.pushing).toBeNull()
    position = await during(world, position, () => world.finish(0))
    expect(position.state.pushing).toBe(0)
    expect(world.pushed).toEqual([])
    position = await round(config, world, position)
    expect(world.pushed).toEqual([[{ id: 1, rev: 0 }]])
    expect(statuses(world, position)).toEqual({ 1: "merged" })
  })

  it("orders a run's checks slowest first and predicts its ETA from past runs", async () => {
    const world = makeWorld(config, { duration: (check) => check === 2 ? 300 : 20 })
    world.enqueue(1)
    let position: Driver.Position = await until(world, start, (outcome) => statuses(world, outcome)[1] === "merged")
    world.enqueue(2)
    position = await round(config, world, position)
    position = await round(config, world, position)
    expect(world.runs.get(1)!.job).toMatchObject({ checks: [2, 1], eta: 300 })
    expect(Driver.job(config, position.state, 99)).toBeUndefined()
  })
})

describe("the queue never blocks", () => {
  it("lands a later change while an earlier one is being fixed", async () => {
    const world = makeWorld(config, { failing: (entry) => entry.id === 1 && entry.rev === 0 ? [1] : [] })
    world.enqueue(1)
    let position: Driver.Position = await until(world, start, (outcome) => statuses(world, outcome)[1] === "fixing")
    world.enqueue(2)
    position = await until(world, position, (outcome) => statuses(world, outcome)[2] === "merged")
    expect(statuses(world, position)).toEqual({ 1: "fixing", 2: "merged" })
    world.answer(1, 1, { _tag: "fixed" })
    world.close()
    const end = await drain(world, position)
    expect(statuses(world, end)).toEqual({ 1: "merged", 2: "merged" })
    expect(show(world.targets.at(-1)!)).toEqual(["2.0", "1.1"])
    expectSound(world)
  })

  it("takes a withdrawal while the change is under test and stops its run", async () => {
    const world = makeWorld(config, { auto: false })
    world.enqueue(1)
    let position: Driver.Position = await round(config, world, start)
    position = await during(world, position, () => {
      world.withdraw(1)
      world.close()
    })
    expect(statuses(world, position)).toEqual({ 1: "withdrawn" })
    expect((await drain(world, position)).done).toBe(true)
    await round(config, world, position)
    expect(world.log).toContain("ci.stop 0")
  })
})

describe("everything is rebased on the tip of the target", () => {
  const pushing = async (world: World): Promise<Driver.Position> => {
    world.enqueue(1)
    const position = await round(config, world, start)
    return during(world, position, () => world.finish(0, 2))
  }

  it("the target moves between test and land: the stale tree is not pushed, the stack is rebuilt on the new tip", async () => {
    const world = makeWorld(config, { auto: false })
    let position = await pushing(world)
    expect(position.state.pushing).toBe(0)
    world.foreign(900)
    position = await round(config, world, position)
    expect(world.pushed).toEqual([])
    expect(show(wholeTree(world, position))).toEqual(["900.0"])
    // The foreign commit is behind every run the queue holds, so it is cut: the new run's base is empty.
    expect(position.settled).toBe(1)
    expect(position.state.runs.map((run) => [show(run.base), show(run.batch)])).toEqual([[[], ["1.0"]]])
    position = await during(world, position, () => {
      world.finish(1, 2)
      world.close()
    })
    const end = await drain(world, position)
    expect(show(world.targets.at(-1)!)).toEqual(["900.0", "1.0"])
    expect(world.pushed.map(show)).toEqual([["900.0", "1.0"]])
    expect(end.state.landed).toEqual([])
    expect(world.endings.map((ending) => [ending.id, ending.landing!.foreign])).toEqual([[900, true], [1, false]])
    expectSound(world)
  })

  it("a commit that lands right after the queue's push is adopted on top of the landing", async () => {
    const world = makeWorld(config, { auto: false })
    let position = await pushing(world)
    await Effect.runPromise(Driver.sync(Driver.commands(config, position.state)).pipe(Effect.provide(world.layer)))
    world.foreign(901)
    position = await round(config, world, position)
    expect(show(wholeTree(world, position))).toEqual(["1.0", "901.0"])
    expect(statuses(world, position)).toEqual({ 1: "merged", 901: "merged" })
    expectSound(world)
  })

  it("keeps landing while other people push to the target", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    let position: Driver.Position = await round(config, world, start)
    world.foreign(900)
    position = await until(world, position, (outcome) => statuses(world, outcome)[1] === "merged")
    world.foreign(901)
    world.enqueue(2)
    world.close()
    const end = await drain(world, position)
    expect(show(wholeTree(world, end))).toEqual(["900.0", "1.0", "901.0", "2.0"])
    expectSound(world)
  })

  it("fails the round, changing nothing, when the target's history was rewritten", async () => {
    // Below the parts the queue has settled: the target has no tree to speak of any more.
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    const end = await drain(world)
    expect(end.settled).toBe(1)
    world.rewrite([])
    const below = await Effect.runPromise(Effect.flip(Driver.round(config, end)).pipe(Effect.provide(world.layer)))
    expect(below).toMatchObject({ _tag: "@smthrs/merge-queue/Unavailable", service: "target" })

    // Among the parts the queue still holds: the tip does not extend the tree the queue knows.
    const other = makeWorld(config, { auto: false })
    other.enqueue(1)
    other.enqueue(2)
    let position: Driver.Position = await round(config, other, start)
    // One run tests change 1 alone and lands it; the other, on both changes, was built on the empty tree and is held.
    position = await during(other, position, () => {
      const alone = [...other.runs.values()].find((record) => record.job.tree.length === 1)!
      other.finish(alone.job.run, 2)
    })
    position = await until(other, position, (outcome) => statuses(other, outcome)[1] === "merged")
    expect([position.settled, show(position.state.main)]).toEqual([0, ["1.0"]])
    other.rewrite([])
    const exit = await roundExit(config, other, position)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("TargetDiverged")
  })

  it("fails the round when someone else put one of the queue's own changes on the target", async () => {
    const world = makeWorld(config, { auto: false })
    world.enqueue(1)
    const position = await round(config, world, start)
    world.foreign(1)
    const exit = await roundExit(config, world, position)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("TargetDiverged")
    expect(new TargetDiverged({ known: [], found: [] })._tag).toBe("@smthrs/merge-queue/TargetDiverged")
  })

  it(
    "fuzz: random failures, fixes and foreign commits; the target only fast-forwards onto tested green trees",
    async () => {
      for (let seed = 1; seed <= 60; seed++) {
        const next = random(seed)
        const settings: Config = {
          required: [1, 2],
          maxAttempts: 1 + Math.floor(next() * 2),
          maxBatch: 1 + Math.floor(next() * 4),
          maxRuns: 1 + Math.floor(next() * 3),
          window: 3,
          defaultDuration: 10
        }
        const broken = new Set([1, 2, 3, 4, 5, 6, 7, 8].filter(() => next() < 0.3))
        const hopeless = new Set([...broken].filter(() => next() < 0.3))
        const world = makeWorld(settings, {
          failing: (entry) =>
            broken.has(entry.id) && (entry.rev === 0 || hopeless.has(entry.id)) ? [1 + (entry.id % 2)] : [],
          fix: (brief) => next() < 0.2 ? { _tag: "gaveUp", detail: "redo it" } : { _tag: "fixed" }
        })
        let position: Driver.Position = start
        let queued = 0
        let closed = false
        let end: Driver.Outcome | undefined
        // Something to do to the world: hand in a change, push a foreign commit, or close.
        const poke = (rounds: number): void => {
          if (queued < 8 && next() < 0.6) world.enqueue(++queued, Math.floor(next() * 3))
          else if (rounds < 60 && next() < 0.5) world.foreign(900 + world.targets.length)
          else if (queued < 8) world.enqueue(++queued)
          else if (!closed) {
            closed = true
            world.close()
          } else throw new Error(`seed ${seed}: the queue is waiting and the world owes it nothing`)
        }
        for (let rounds = 0; rounds < 400 && end === undefined; rounds++) {
          if (next() < 0.4 && !(closed && queued === 8)) poke(rounds)
          let outcome: Driver.Outcome | undefined
          const pending = round(settings, world, position).then((settled) => (outcome = settled))
          await Promise.race([pending, tick()])
          // A round that is still running is waiting for news: give it some.
          while (outcome === undefined) {
            poke(rounds)
            await Promise.race([pending, tick()])
          }
          position = outcome
          if (outcome.done) end = outcome
        }
        expect(end, `seed ${seed}`).toBeDefined()
        expect(sameTree(wholeTree(world, end!), world.targets.at(-1)!), `seed ${seed}`).toBe(true)
        // With no run left, everything on the target is settled and the state's tree is empty.
        expect([end!.settled, end!.state.main], `seed ${seed}`).toEqual([world.targets.at(-1)!.length, []])
        expect(
          Object.values(statuses(world, end!)).every((status) =>
            ["merged", "unmergeable", "withdrawn"].includes(status)
          )
        )
          .toBe(true)
        expectSound(world, settings)
        expectRecorded(world, end!, settings, `seed ${seed}`)
      }
    },
    240_000
  )
})

describe("what the queue carries between rounds", () => {
  it("holds only the changes still in the queue, however many have ended", async () => {
    const settings: Config = { ...config, maxBatch: 3, maxRuns: 3 }
    const world = makeWorld(settings, {
      failing: (entry) => entry.id % 7 === 0 && entry.rev === 0 ? [1] : [],
      fix: (brief) => brief.id % 14 === 0 ? { _tag: "gaveUp", detail: "redo it" } : { _tag: "fixed" }
    })
    let position: Driver.Position = start
    let live = 0
    let longest = 0
    let largest = 0
    for (let id = 1; id <= 120; id++) {
      world.enqueue(id)
      if (id % 10 === 0) world.withdraw(id)
      position = await round(settings, world, position)
      expect(position.state.changes.every((change) => ["queued", "fixing"].includes(change.status._tag))).toBe(true)
      expect(position.state.landed).toEqual([])
      // The state's tree is what the target holds after the parts the queue settled.
      expect(wholeTree(world, position)).toEqual(world.targets.at(-1))
      live = Math.max(live, position.state.changes.length)
      longest = Math.max(longest, position.state.main.length)
      largest = Math.max(largest, JSON.stringify(position).length)
    }
    world.close()
    const end = await drain(world, position, settings)
    expect(world.endings).toHaveLength(120)
    expect(world.targets.at(-1)!.length).toBeGreaterThan(100)
    expect(end.settled).toBe(world.targets.at(-1)!.length)
    // At most a handful of changes are in the queue at once, so the state never holds more than that:
    // not the changes that ended, not the tree they landed in. What a host records stays a few kilobytes
    // while 120 changes go through.
    expect(live).toBeLessThan(12)
    expect(longest).toBeLessThan(12)
    expect(largest).toBeLessThan(6_000)
    expectRecorded(world, end, settings)
    expectSound(world, settings)
  })
})

describe("the record of endings", () => {
  const oneIsHopeless: Script = {
    failing: (entry) => entry.id === 1 ? [1] : [],
    fix: () => ({ _tag: "gaveUp", detail: "conflicts with the new parser; redo it" })
  }

  it("holds every ended change once: merged with its landing, unmergeable with its reason, withdrawn", async () => {
    const world = makeWorld(config, oneIsHopeless)
    world.foreign(900)
    world.enqueue(1)
    world.enqueue(2)
    world.enqueue(3)
    world.withdraw(3)
    world.close()
    const end = await drain(world)
    expect(statuses(world, end)).toEqual({ 900: "merged", 1: "unmergeable", 2: "merged", 3: "withdrawn" })
    expectRecorded(world, end)
    const byId = Object.fromEntries(world.endings.map((ending) => [ending.id, ending]))
    expect(byId[900]).toEqual({
      id: 900,
      rev: 0,
      attempts: 0,
      status: { _tag: "merged" },
      landing: { run: 0, results: [], foreign: true }
    })
    expect(byId[1]).toMatchObject({
      attempts: 1,
      status: {
        _tag: "unmergeable",
        reason: { kind: "agentVerdict", detail: "conflicts with the new parser; redo it", failures: [1], attempts: 1 }
      },
      landing: null
    })
    expect(byId[2]!.landing).toMatchObject({
      foreign: false,
      results: [{ check: 1, verdict: "pass" }, { check: 2, verdict: "pass" }]
    })
    expect(byId[3]).toEqual({ id: 3, rev: 0, attempts: 0, status: { _tag: "withdrawn" }, landing: null })
    expectSound(world)
  })

  it("is written the round after the change ended, and the queue is not done before it is", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    const landed = await until(world, start, (outcome) => statuses(world, outcome)[1] === "merged")
    expect(landed.ended.map((ending) => [ending.id, ending.status._tag])).toEqual([[1, "merged"]])
    expect(landed.done).toBe(false)
    expect(world.endings).toEqual([])
    const after = await round(config, world, landed)
    expect(world.endings).toEqual(landed.ended)
    expect(after).toMatchObject({ ended: [], done: true })
    expect(after.state).toEqual(landed.state)
  })

  it("fails the round while the record cannot be written, and writes it at the next try", async () => {
    const world = makeWorld(config)
    world.enqueue(1)
    world.close()
    const landed = await until(world, start, (outcome) => outcome.ended.length > 0)
    world.failNext("endings", 1)
    const failure = await Effect.runPromise(Effect.flip(Driver.round(config, landed)).pipe(Effect.provide(world.layer)))
    expect(failure).toMatchObject({ _tag: "@smthrs/merge-queue/Unavailable", service: "endings" })
    expect(world.endings).toEqual([])
    expect((await round(config, world, landed)).done).toBe(true)
    expect(world.endings).toEqual(landed.ended)
    // The same round again, as after a crash: recorded once.
    await round(config, world, landed)
    expect(world.endings).toEqual(landed.ended)
  })

  it("holds only the decision that was kept when a round ran twice and decided differently", async () => {
    const world = makeWorld(config, { failing: (entry) => entry.id === 1 ? [1] : [] })
    world.enqueue(1)
    const fixing = await until(world, start, (outcome) => statuses(world, outcome)[1] === "fixing")
    world.answer(1, 1, { _tag: "gaveUp", detail: "redo it" })
    // The host dies before it keeps this round's outcome.
    const dropped = await round(config, world, fixing)
    expect(dropped.ended.map((ending) => ending.status._tag)).toEqual(["unmergeable"])
    // The author takes the change back before the host is up again; the round runs again.
    world.withdraw(1)
    world.close()
    const kept = await round(config, world, fixing)
    expect(kept.ended.map((ending) => ending.status._tag)).toEqual(["withdrawn"])
    expect(world.endings).toEqual([])
    const end = await drain(world, kept)
    expect(world.endings).toEqual([{ id: 1, rev: 0, attempts: 1, status: { _tag: "withdrawn" }, landing: null }])
    expectRecorded(world, end)
  })

  it("names what ended between two states and nothing that had ended before", () => {
    const one = run(config, empty, [
      { _tag: "enqueue", id: 1, priority: 0 },
      { _tag: "enqueue", id: 2, priority: 0 },
      { _tag: "withdraw", id: 1 }
    ])
    const two = run(config, one, [
      { _tag: "foreign", id: 7 },
      { _tag: "enqueue", id: 3, priority: 0 },
      { _tag: "withdraw", id: 3 }
    ])
    expect(Driver.ended(empty, one).map((ending) => ending.id)).toEqual([1])
    expect(Driver.ended(one, one)).toEqual([])
    expect(Driver.ended(one, two)).toEqual([
      { id: 7, rev: 0, attempts: 0, status: { _tag: "merged" }, landing: { run: 0, results: [], foreign: true } },
      { id: 3, rev: 0, attempts: 0, status: { _tag: "withdrawn" }, landing: null }
    ])
    expect(Driver.ended(empty, two).map((ending) => ending.id)).toEqual([1, 7, 3])
  })
})

describe("waiting", () => {
  it("waits for the world when there is nothing new and nothing to decide", async () => {
    const world = makeWorld(config, { auto: false })
    world.enqueue(1)
    const position = await round(config, world, start)
    let settled = false
    const waiting = round(config, world, position).then((outcome) => {
      settled = true
      return outcome
    })
    await tick()
    await tick()
    expect(settled).toBe(false)
    world.finish(0, 2)
    expect((await waiting).state.pushing).toBe(0)
  })

  it("wakes for a fix agent's answer, for a moved target and for a new letter", async () => {
    const world = makeWorld(config, { failing: (entry) => entry.rev === 0 && entry.id === 1 ? [1] : [] })
    world.enqueue(1)
    let position: Driver.Position = await until(world, start, (outcome) => statuses(world, outcome)[1] === "fixing")
    position = await during(world, position, () => world.answer(1, 1, { _tag: "gaveUp", detail: "no" }))
    expect(statuses(world, position)).toEqual({ 1: "unmergeable" })
    position = await during(world, position, () => world.foreign(7))
    expect(show(wholeTree(world, position))).toEqual(["7.0"])
    expect((await during(world, position, () => world.close())).done).toBe(true)
  })
})

describe("failures of the world", () => {
  it("restarts a run CI lost, under a new run id", async () => {
    const world = makeWorld(config, { auto: false })
    world.enqueue(1)
    let position: Driver.Position = await round(config, world, start)
    position = await during(world, position, () => world.lose(0))
    expect(position.state.runs.map((entry) => entry.id)).toEqual([1])
    position = await during(world, position, () => {
      world.finish(1, 2)
      world.close()
    })
    const end = await drain(world, position)
    expect(statuses(world, end)).toEqual({ 1: "merged" })
    expectSound(world)
  })

  it.each(["inbox", "ci", "fixer", "target"] as const)(
    "a round fails when %s is unavailable, and the same round succeeds when tried again",
    async (service) => {
      const world = makeWorld(config, threeIsBroken)
      const calm = makeWorld(config, threeIsBroken)
      for (const each of [world, calm]) {
        for (const id of [1, 2, 3]) each.enqueue(id)
        each.close()
      }
      let position: Driver.Position = start
      let failures = 0
      let end: Driver.Outcome | undefined
      for (let rounds = 0; rounds < 400 && end === undefined; rounds++) {
        if (rounds % 2 === 1) world.failNext(service, 1)
        const exit = await roundExit(config, world, position)
        if (Exit.isFailure(exit)) {
          failures += 1
          continue
        }
        position = exit.value
        if (exit.value.done) end = exit.value
      }
      expect(failures).toBeGreaterThan(0)
      const expected = await drain(calm)
      expect(end && wholeTree(world, end)).toEqual(wholeTree(calm, expected))
      expect(statuses(world, end!)).toEqual(statuses(calm, expected))
      expectSound(world)
    }
  )

  it("reports the service that could not answer", async () => {
    const world = makeWorld(config)
    world.failNext("inbox", 1)
    const exit = await roundExit(config, world, start)
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Unavailable")
    expect(new Unavailable({ service: "ci", detail: "down" }).service).toBe("ci")
  })
})

describe("crash and restart", () => {
  const scenario = (): World => {
    const world = makeWorld(config, threeIsBroken)
    for (const id of [1, 2, 3, 4, 5]) world.enqueue(id, id === 5 ? 3 : 0)
    world.close()
    return world
  }

  it("a crash at every single service call of the whole run ends with the same result", async () => {
    const calm = scenario()
    const expected = await drain(calm)
    expect(calm.calls()).toBeGreaterThan(30)
    for (let crashAt = 0; crashAt < calm.calls(); crashAt++) {
      const world = scenario()
      world.failCall(crashAt)
      let position: Driver.Position = start
      let crashed = 0
      let end: Driver.Outcome | undefined
      for (let rounds = 0; rounds < 400 && end === undefined; rounds++) {
        const exit = await roundExit(config, world, position)
        if (Exit.isFailure(exit)) {
          crashed += 1
          continue
        }
        position = exit.value
        if (exit.value.done) end = exit.value
      }
      expect(crashed, `crash at call ${crashAt}`).toBe(1)
      expect(end && wholeTree(world, end), `crash at call ${crashAt}`).toEqual(wholeTree(calm, expected))
      expect(statuses(world, end!)).toEqual(statuses(calm, expected))
      expect(world.targets.at(-1)).toEqual(calm.targets.at(-1))
      expectSound(world)
      expectRecorded(world, end!, config, `crash at call ${crashAt}`)
      expect(world.endings).toEqual(calm.endings)
    }
  }, 240_000)
})

describe("commands", () => {
  it("are derived from the state alone: the push under way, the wanted runs, the fix briefs", async () => {
    const world = makeWorld(config, { failing: (entry) => entry.id === 2 ? [1] : [] })
    world.enqueue(1)
    world.enqueue(2)
    const pushing = await until(world, start, (outcome) => outcome.state.pushing !== null)
    expect(Driver.commands(config, pushing.state).advance).toEqual({ from: [], to: [{ id: 1, rev: 0 }] })
    const position = await until(world, pushing, (outcome) => statuses(world, outcome)[2] === "fixing")
    const issued = Driver.commands(config, position.state)
    expect(issued.advance).toBeNull()
    expect(issued.briefs).toEqual([{ id: 2, rev: 0, attempt: 1, failures: [1], ahead: [] }])
    expect(issued.jobs).toEqual([])
    expect(Driver.commands(config, empty)).toEqual({ settled: 0, advance: null, jobs: [], briefs: [] })
    expect(Driver.commands(config, position.state, 7)).toMatchObject({ settled: 7, jobs: [] })
    expect(Driver.job(config, pushing.state, 0, 7)).toMatchObject({ run: 0, from: 7 })
    expect(Driver.drained(position.state)).toBe(false)
    expect(Driver.drained(empty)).toBe(true)
  })

  it("the tip says what happened: nothing, the queue's landing, or commits from someone else", () => {
    const tree = (...ids: ReadonlyArray<number>): Tree => ids.map((id) => ({ id, rev: 0 }))
    const pushingState: State = {
      ...empty,
      changes: [{ id: 1, priority: 0, seq: 0, rev: 0, attempts: 0, status: { _tag: "queued" } }],
      runs: [{ id: 4, base: [], batch: tree(1), results: [] }],
      pushing: 4
    }
    expect(Driver.tipEvents(empty, [])).toEqual([])
    expect(Driver.tipEvents(pushingState, [])).toEqual([])
    expect(Driver.tipEvents(pushingState, tree(1))).toEqual([{ _tag: "land", run: 4 }])
    expect(Driver.tipEvents(pushingState, tree(1, 9))).toEqual([{ _tag: "land", run: 4 }, { _tag: "foreign", id: 9 }])
    expect(Driver.tipEvents(pushingState, tree(9))).toEqual([{ _tag: "foreign", id: 9 }])
    expect(Driver.tipEvents({ ...empty, main: tree(1) }, [])).toBeUndefined()
  })
})

describe("schemas", () => {
  it("accept every state, config and event the kernel produces, unchanged", async () => {
    const kernel = await import("../src/Kernel.ts")
    const all = steps(kernel, 40, 80)
    const decodeState = Schema.decodeUnknownSync(QueueSchema.State)
    const decodeConfig = Schema.decodeUnknownSync(QueueSchema.Config)
    const decodeEvent = Schema.decodeUnknownSync(QueueSchema.Event)
    for (const entry of all) {
      expect(decodeState(JSON.parse(JSON.stringify(entry.after)))).toEqual(entry.after)
      expect(decodeConfig(entry.config)).toEqual(entry.config)
      expect(decodeEvent(entry.event)).toEqual(entry.event)
    }
    expect(all.length).toBeGreaterThan(1000)
  })

  it("refuse a state that is not one", () => {
    expect(() => Schema.decodeUnknownSync(QueueSchema.State)({ main: [{ id: -1, rev: 0 }] })).toThrow()
    expect(() => Schema.decodeUnknownSync(QueueSchema.Verdict)("maybe")).toThrow()
  })
})
