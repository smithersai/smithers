// The stack's rules (src/features/todos/stack.ts, decision 0016 §1 and §7, decision 0135): property tests over random
// histories of commits (stacked by the stack's base, after a picked TODO, or independent), drops, retries, settings
// changes, and runs publishing, failing, merging and closing, on stacks of random lanes, limits and bases, against a
// model that is only a list of ids in order; and the rules one case at a time.
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { STACK_BASES } from "./contract"
import { apply, isReady, openOf, type Op, type Result, type Row, type Stack, violations } from "./stack"

const Pick = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 }))
const Lanes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
const MaxOpen = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))
const Base = Schema.Literals(STACK_BASES)

/**
 * One step of a random history: a person's commit (its `after` the stack's base, none, or a picked TODO), drop, retry
 * or settings change; or a run publishing, failing, merging or closing its started TODO (Track B's writer ops).
 */
const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("commit"), after: Schema.Literals(["base", "none", "pick"]), pick: Pick }),
  Schema.Struct({ kind: Schema.Literals(["publish", "drop", "again", "fail", "merge", "close", "retry", "stale"]), pick: Pick }),
  Schema.Struct({ kind: Schema.Literal("configure"), lanes: Lanes, maxOpen: MaxOpen, base: Base }),
])
type Step = typeof Step.Type

const history = (steps: Arbitrary.Arbitrary<Step>) =>
  Arbitrary.all({
    lanes: Arbitrary.schema(Lanes),
    maxOpen: Arbitrary.schema(MaxOpen),
    base: Arbitrary.schema(Base),
    steps: Arbitrary.array(steps, { maxLength: 80 }),
  })
type History = { readonly lanes: number; readonly maxOpen: number; readonly base: Stack["base"]; readonly steps: ReadonlyArray<Step> }

/** Every kind of step. */
const Mixed = history(Arbitrary.schema(Step))

/** Histories whose commits take the stack's base, which never changes: what a repository that set one sees. */
const ByBase = (base: Stack["base"]) =>
  Arbitrary.map(
    history(Arbitrary.filter(Arbitrary.schema(Step), (step) => step.kind !== "configure")),
    (drawn): History => ({
      ...drawn,
      base,
      steps: drawn.steps.map((step) => step.kind === "commit" ? { ...step, after: "base" } : step),
    }),
  )

const empty = (history: History): Stack => ({
  nextNumber: 1,
  lanes: history.lanes,
  maxOpen: history.maxOpen,
  base: history.base,
  todos: [],
})

/** Runs a property over `runs` random histories; fails the test with the shrunk history when it doesn't hold. */
const check = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => boolean, runs = 1500) => {
  // `size` lets histories grow to their full length: checking starts small and grows toward it.
  const result = await Effect.runPromise(Arbitrary.checkEffect(arbitrary, property, { runs, size: 100, seed: 20261031 }))
  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
}

interface Played {
  readonly before: Stack
  readonly after: Stack
  readonly op: Op
  readonly result: Result
  readonly model: ReadonlyArray<string>
}

/**
 * The op a step makes on `stack`, or none when no TODO can take it. A run's report picks among the live attempts; a
 * person's drop or retry, and a `stale` report, among every TODO ever made, settled ones included, so drops of dropped
 * TODOs and stale reports come up.
 */
const opOf = (stack: Stack, step: Step, id: () => string): Op | undefined => {
  if (step.kind === "configure") return { kind: "configure", lanes: step.lanes, maxOpen: step.maxOpen, base: step.base }
  const among = (todos: ReadonlyArray<Row>) => todos[step.pick % Math.max(todos.length, 1)]
  const any = among(stack.todos)
  if (step.kind === "commit") {
    return {
      kind: "commit",
      id: id(),
      ...(step.after === "none" ? { after: null } : step.after === "pick" ? { after: any?.number ?? step.pick + 1 } : {}),
    }
  }
  if (step.kind === "drop" || step.kind === "again" || step.kind === "retry") {
    return { kind: step.kind === "retry" ? "retry" : "drop", number: (step.kind === "retry" ? among(stack.todos.filter((todo) => todo.state === "failed")) ?? any : any)?.number ?? step.pick + 1 }
  }
  if (step.kind === "stale") {
    return any === undefined ? undefined : { kind: "finish", id: any.id, ordinal: any.attempt - 1, state: "merged" }
  }
  const live = among(stack.todos.filter((todo) => step.kind === "publish" ? todo.state === "working" : todo.state === "working" || todo.state === "in_review"))
  if (live === undefined) return undefined
  if (step.kind === "publish") return { kind: "publish", id: live.id, ordinal: live.attempt }
  return { kind: "finish", id: live.id, ordinal: live.attempt, state: step.kind === "fail" ? "failed" : step.kind === "merge" ? "merged" : "dropped" }
}

/**
 * Plays `history` from an empty stack, with the model alongside: the ids of the open TODOs in order. Calls `each` after
 * every step that made an op; answers whether every call held.
 */
const play = (history: History, each: (played: Played) => boolean) => {
  let stack = empty(history)
  let model: Array<string> = []
  let ids = 0
  for (const step of history.steps) {
    const before = stack
    const op = opOf(before, step, () => `todo-${++ids}`)
    if (op === undefined) continue
    const applied = apply(before, op)
    stack = applied.stack
    if (applied.result.kind === "committed" && op.kind === "commit") model = [...model, op.id]
    const left = stack.todos.filter((todo) => todo.position === null && before.todos.find((was) => was.id === todo.id)?.position !== null)
    model = model.filter((id) => !left.some((todo) => todo.id === id))
    if (!each({ before, after: stack, op, result: applied.result, model })) return false
    // `again`: the same drop once more answers dropped and changes nothing.
    if (step.kind === "again" && op.kind === "drop" && applied.result.kind === "dropped") {
      const repeated = apply(stack, op)
      if (repeated.result.kind !== "dropped" || repeated.result.changed || repeated.stack !== stack) return false
    }
  }
  return true
}

const openIds = (stack: Stack) => openOf(stack).map((todo) => todo.id)
const working = (stack: Stack) => stack.todos.filter((todo) => todo.state === "working").length
const startsOf = (result: Result) => result.kind === "refused" ? [] : result.starts
const changed = ({ before, after, result }: Played) =>
  result.kind !== "refused" && !(result.kind === "dropped" && !result.changed) && before !== after

/** The TODOs on `todo`'s after chain, nearest first. */
const chainOf = (stack: Stack, todo: Row): ReadonlyArray<Row> => {
  const chain: Array<Row> = []
  for (let id = todo.after; id !== null && chain.length <= stack.todos.length;) {
    const row = stack.todos.find((candidate) => candidate.id === id)
    if (row === undefined) break
    chain.push(row)
    id = row.after
  }
  return chain
}

describe("the stack's invariants, over random histories", () => {
  test("every stack keeps the rules: unique numbers, positions 1 to n, settled unplaced, after an open TODO before", () =>
    check(Mixed, (history) => play(history, ({ after }) => violations(after).length === 0)))

  test("order is the model's: commits append, drops, merges and closes take out, nothing else moves", () =>
    check(Mixed, (history) => play(history, ({ after, model }) => JSON.stringify(openIds(after)) === JSON.stringify(model))))

  test("numbers count up from 1 and are never reused", () =>
    check(Mixed, (history) => {
      const seen = new Set<number>()
      return play(history, ({ before, result }) => {
        if (result.kind !== "committed") return true
        if (seen.has(result.number) || result.number !== before.nextNumber) return false
        seen.add(result.number)
        return true
      })
    }))

  test("Drop is idempotent: the same drop again answers dropped and changes nothing", () =>
    check(
      Arbitrary.map(Mixed, (history) => ({
        ...history,
        steps: history.steps.map((step): Step => (step.kind === "drop" ? { kind: "again", pick: step.pick } : step)),
      })),
      (history) => play(history, () => true),
    ))

  test("a refused change leaves the stack exactly as it was", () =>
    check(Mixed, (history) => play(history, ({ before, after, result }) => result.kind !== "refused" || before === after)))

  test("no lane idles while a ready TODO waits", () =>
    check(Mixed, (history) =>
      play(history, (played) =>
        !changed(played) || working(played.after) >= played.after.lanes ||
        openOf(played.after).every((todo) => !isReady(played.after.todos, todo)))))

  test("a TODO starts only once every TODO on its after chain is In review", () =>
    check(Mixed, (history) =>
      play(history, ({ after, result }) =>
        startsOf(result).every((start) => {
          const row = after.todos.find((todo) => todo.id === start.todoId)!
          return chainOf(after, row).every((on) => on.state === "in_review")
        }))))

  test("each start is the oldest ready TODO, on its next attempt, into a free lane", () =>
    check(Mixed, (history) =>
      play(history, ({ before, after, result }) => {
        const starts = startsOf(result)
        if (starts.length > 0 && working(after) > after.lanes) return false
        const started = new Set(starts.map((start) => start.todoId))
        const youngest = Math.max(0, ...after.todos.filter((todo) => started.has(todo.id)).map((todo) => todo.position!))
        const passedOver = openOf(after).some((todo) => todo.position! < youngest && isReady(after.todos, todo))
        return !passedOver && starts.every((start) => {
          const was = before.todos.find((todo) => todo.id === start.todoId)
          const now = after.todos.find((todo) => todo.id === start.todoId)!
          return now.state === "working" && now.attempt === start.ordinal && start.ordinal === (was?.attempt ?? 0) + 1
        })
      })))

  test("a failure holds only the TODOs whose after chain runs through it", () =>
    check(Mixed, (history) =>
      play(history, ({ before, after, op, result }) => {
        if (op.kind !== "finish" || op.state !== "failed" || result.kind === "refused") return true
        return openOf(before).every((todo) => {
          if (!isReady(before.todos, todo) || chainOf(before, todo).some((on) => on.id === op.id)) return true
          const now = after.todos.find((row) => row.id === todo.id)!
          return now.state === "working" || isReady(after.todos, now)
        })
      })))

  test("independent: with no after, a failure holds nothing and every Queued TODO is ready", () =>
    check(ByBase("independent"), (history) =>
      play(history, ({ after }) => openOf(after).every((todo) => todo.after === null && (todo.state !== "queued" || isReady(after.todos, todo))))))

  test("stacked: a TODO starts only once every open TODO before it is In review, as the stack did before lanes", () =>
    check(ByBase("stacked"), (history) =>
      play(history, ({ after, result }) =>
        startsOf(result).every((start) => {
          const row = after.todos.find((todo) => todo.id === start.todoId)!
          return openOf(after).filter((todo) => todo.position! < row.position!).every((todo) => todo.state === "in_review")
        }))))

  test("a TODO that leaves after publishing fails the Queued TODOs stacked on it, and only those", () =>
    check(Mixed, (history) =>
      play(history, ({ before, after, op, result }) => {
        if (result.kind !== "dropped" && !(result.kind === "finished" && result.state !== "failed")) return true
        if (op.kind !== "drop" && op.kind !== "finish") return true
        const target = before.todos.find((todo) => op.kind === "drop" ? todo.number === op.number : todo.id === op.id)!
        if (target.position === null) return true
        const published = result.kind === "finished" ? result.state === "dropped" : target.state === "in_review"
        return before.todos.every((todo) => {
          const now = after.todos.find((row) => row.id === todo.id)!
          const failed = todo.state === "queued" && now.state === "failed"
          return failed === (published && todo.after === target.id && todo.state === "queued") &&
            (todo.after !== target.id || todo.id === target.id || now.after === target.after)
        })
      })))
})

describe("apply, case by case", () => {
  const row = (fields: Partial<Row> & Pick<Row, "id" | "number" | "position">): Row => ({
    state: "queued",
    attempt: 0,
    revision: 1,
    after: null,
    ...fields,
  })
  const stack = (fields: Partial<Stack>): Stack => ({ nextNumber: 1, lanes: 1, maxOpen: 50, base: "stacked", todos: [], ...fields })

  test("a commit takes the next number and the last position, Queued, revision 1, after the last open TODO", () => {
    const { stack: after, result } = apply(stack({ nextNumber: 7, lanes: 0, todos: [row({ id: "a", number: 6, position: 1 })] }), {
      kind: "commit",
      id: "b",
    })
    expect(result).toEqual({ kind: "committed", number: 7, position: 2, starts: [] })
    expect(after.nextNumber).toBe(8)
    expect(after.todos.find((todo) => todo.id === "b")).toEqual(row({ id: "b", number: 7, position: 2, after: "a" }))
  })

  test("an independent stack's commit stacks on nothing; a commit may name its after, or none, either way", () => {
    const one = [row({ id: "a", number: 1, position: 1 }), row({ id: "b", number: 2, position: 2 })]
    const independent = stack({ nextNumber: 3, lanes: 0, base: "independent", todos: one })
    expect(apply(independent, { kind: "commit", id: "c" }).stack.todos.at(-1)!.after).toBeNull()
    expect(apply(independent, { kind: "commit", id: "c", after: 1 }).stack.todos.at(-1)!.after).toBe("a")
    expect(apply({ ...independent, base: "stacked" }, { kind: "commit", id: "c", after: null }).stack.todos.at(-1)!.after).toBeNull()
  })

  test("a commit after a TODO that isn't open is refused", () => {
    const merged = row({ id: "a", number: 1, position: null, state: "merged" })
    const before = stack({ nextNumber: 2, todos: [merged] })
    for (const after of [1, 9]) {
      expect(apply(before, { kind: "commit", id: "b", after })).toEqual({ stack: before, result: { kind: "refused", code: "after_not_open" } })
    }
  })

  test("a full stack refuses a commit and keeps its next number", () => {
    const full = stack({ nextNumber: 3, lanes: 0, maxOpen: 2, todos: [row({ id: "a", number: 1, position: 1 }), row({ id: "b", number: 2, position: 2 })] })
    expect(apply(full, { kind: "commit", id: "c" })).toEqual({ stack: full, result: { kind: "refused", code: "stack_full" } })
  })

  test("ten independent lanes: ten work at once, the eleventh waits, a failure frees a lane for it", () => {
    let current = stack({ lanes: 10, base: "independent" })
    for (let index = 1; index <= 11; index++) current = apply(current, { kind: "commit", id: `t${index}` }).stack
    expect(current.todos.map((todo) => todo.state)).toEqual([...Array(10).fill("working"), "queued"])
    const failed = apply(current, { kind: "finish", id: "t4", ordinal: 1, state: "failed" })
    expect(failed.result).toMatchObject({ kind: "finished", starts: [{ todoId: "t11" }] })
    // Nine publish; nothing waited on the failed one.
    let after = failed.stack
    for (const id of ["t1", "t2", "t3", "t5", "t6", "t7", "t8", "t9", "t10"]) after = apply(after, { kind: "publish", id, ordinal: 1 }).stack
    expect(after.todos.filter((todo) => todo.state === "in_review")).toHaveLength(9)
    expect(violations(after)).toEqual([])
  })

  test("a TODO after another waits for it to be In review, then starts on it, past younger independent ones", () => {
    const base = stack({ nextNumber: 3, lanes: 3, base: "independent", todos: [row({ id: "a", number: 1, position: 1, state: "working", attempt: 1 })] })
    const waiting = apply(base, { kind: "commit", id: "b", after: 1 })
    expect(waiting.result).toMatchObject({ kind: "committed", starts: [] })
    const free = apply(waiting.stack, { kind: "commit", id: "c" })
    expect(free.result).toMatchObject({ starts: [{ todoId: "c" }] })
    const published = apply(free.stack, { kind: "publish", id: "a", ordinal: 1 })
    expect(published.result).toEqual({ kind: "published", number: 1, starts: [{ todoId: "b", number: 3, ordinal: 1, revision: 1 }] })
  })

  test("a chain waits for every TODO on it: a failed TODO below holds the ones stacked above it", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "failed", attempt: 1 }),
      row({ id: "b", number: 2, position: 2, state: "in_review", attempt: 1, after: "a" }),
      row({ id: "c", number: 3, position: 3, after: "b" }),
    ]
    expect(isReady(todos, todos[2]!)).toBe(false)
    expect(isReady(todos.map((todo) => todo.id === "a" ? { ...todo, state: "in_review" as const } : todo), todos[2]!)).toBe(true)
  })

  test("raising lanes starts the oldest ready TODOs; lowering them stops nothing and starts nothing", () => {
    const todos = [1, 2, 3].map((number) => row({ id: `t${number}`, number, position: number }))
    const raised = apply(stack({ nextNumber: 4, lanes: 0, base: "independent", todos }), { kind: "configure", lanes: 2, maxOpen: 50, base: "independent" })
    expect(raised.result).toMatchObject({ kind: "configured", starts: [{ todoId: "t1" }, { todoId: "t2" }] })
    const lowered = apply(raised.stack, { kind: "configure", lanes: 1, maxOpen: 3, base: "stacked" })
    expect(lowered.result).toEqual({ kind: "configured", starts: [] })
    expect(lowered.stack).toMatchObject({ lanes: 1, maxOpen: 3, base: "stacked" })
    expect(working(lowered.stack)).toBe(2)
    expect(apply(lowered.stack, { kind: "publish", id: "t1", ordinal: 1 }).result).toMatchObject({ starts: [] })
  })

  test("dropping a working TODO stops its attempt, closes the gap, and hands its after to the TODO stacked on it", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 1 }),
      row({ id: "b", number: 2, position: 2, state: "working", attempt: 2, after: "a" }),
      row({ id: "c", number: 3, position: 3, after: "b" }),
    ]
    const { stack: after, result } = apply(stack({ nextNumber: 4, lanes: 1, todos }), { kind: "drop", number: 2 })
    expect(result).toEqual({
      kind: "dropped",
      number: 2,
      changed: true,
      stopped: { todoId: "b", ordinal: 2 },
      starts: [{ todoId: "c", number: 3, ordinal: 1, revision: 1 }],
    })
    expect(after.todos.find((todo) => todo.id === "c")).toMatchObject({ state: "working", position: 2, after: "a" })
  })

  test("dropping a TODO in review stops its run and fails the Queued TODOs stacked on it, only those", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 1 }),
      row({ id: "b", number: 2, position: 2, after: "a" }),
      row({ id: "c", number: 3, position: 3, after: "b" }),
      row({ id: "d", number: 4, position: 4 }),
    ]
    const { stack: after, result } = apply(stack({ nextNumber: 5, lanes: 0, todos }), { kind: "drop", number: 1 })
    expect(result).toMatchObject({ kind: "dropped", stopped: { todoId: "a", ordinal: 1 } })
    expect(openOf(after).map((todo) => [todo.id, todo.state, todo.after])).toEqual([
      ["b", "failed", null],
      ["c", "queued", "b"],
      ["d", "queued", null],
    ])
  })

  test("a merged TODO hands its after on; the TODOs stacked on it start from the default branch", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 1 }),
      row({ id: "b", number: 2, position: 2, after: "a", state: "in_review", attempt: 1 }),
      row({ id: "c", number: 3, position: 3, after: "a" }),
    ]
    const { stack: after, result } = apply(stack({ nextNumber: 4, lanes: 1, todos }), { kind: "finish", id: "a", ordinal: 1, state: "merged" })
    expect(result).toEqual({ kind: "finished", number: 1, state: "merged", starts: [{ todoId: "c", number: 3, ordinal: 1, revision: 1 }] })
    expect(after.todos.map((todo) => [todo.id, todo.state, todo.position, todo.after])).toEqual([
      ["a", "merged", null, null],
      ["b", "in_review", 1, null],
      ["c", "working", 2, null],
    ])
  })

  test("a PR closed on GitHub drops its TODO and fails what was queued on it; a failed run keeps its place", () => {
    const review = row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 2 })
    const queued = row({ id: "b", number: 2, position: 2, after: "a" })
    const closed = apply(stack({ nextNumber: 3, lanes: 0, todos: [review, queued] }), { kind: "finish", id: "a", ordinal: 2, state: "dropped" })
    expect(closed.stack.todos.map((todo) => [todo.state, todo.position])).toEqual([["dropped", null], ["failed", 1]])
    const failedRun = apply(stack({ nextNumber: 3, lanes: 1, todos: [review, queued] }), { kind: "finish", id: "a", ordinal: 2, state: "failed" })
    expect(failedRun.stack.todos.map((todo) => [todo.state, todo.position])).toEqual([["failed", 1], ["queued", 2]])
    expect(failedRun.result).toEqual({ kind: "finished", number: 1, state: "failed", starts: [] })
  })

  test("a stale report changes nothing: another attempt, a dropped TODO, a Queued one, an unknown one", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "working", attempt: 2 }),
      row({ id: "b", number: 2, position: null, state: "dropped", attempt: 1 }),
      row({ id: "c", number: 3, position: 2 }),
    ]
    const before = stack({ nextNumber: 4, todos })
    for (const op of [
      { kind: "publish", id: "a", ordinal: 1 },
      { kind: "publish", id: "b", ordinal: 1 },
      { kind: "publish", id: "c", ordinal: 0 },
      { kind: "publish", id: "z", ordinal: 1 },
      { kind: "finish", id: "a", ordinal: 1, state: "merged" },
      { kind: "finish", id: "b", ordinal: 1, state: "failed" },
      { kind: "finish", id: "z", ordinal: 1, state: "dropped" },
    ] as const) {
      expect(apply(before, op)).toEqual({ stack: before, result: { kind: "refused", code: "stale" } })
    }
  })

  test("publishing again with a new head changes nothing", () => {
    const before = stack({ nextNumber: 2, todos: [row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 1 })] })
    expect(apply(before, { kind: "publish", id: "a", ordinal: 1 }).result).toEqual({ kind: "published", number: 1, starts: [] })
  })

  test("a merged TODO can't be dropped, an unknown number isn't found, and dropping a Queued one stops nothing", () => {
    const before = stack({ nextNumber: 3, lanes: 0, todos: [row({ id: "a", number: 1, position: null, state: "merged", attempt: 1 }), row({ id: "b", number: 2, position: 1 })] })
    expect(apply(before, { kind: "drop", number: 1 }).result).toEqual({ kind: "refused", code: "merged" })
    expect(apply(before, { kind: "drop", number: 9 }).result).toEqual({ kind: "refused", code: "not_found" })
    expect(apply(before, { kind: "drop", number: 2 }).result).toMatchObject({ kind: "dropped", changed: true, stopped: undefined, starts: [] })
  })

  test("retry keeps the failed TODO in place and starts attempt two; anything not failed refuses", () => {
    const failed = stack({ nextNumber: 2, todos: [row({ id: "one", number: 1, position: 1, state: "failed", attempt: 1 })] })
    const retried = apply(failed, { kind: "retry", number: 1 })
    expect(retried.result).toMatchObject({ kind: "retried", starts: [{ todoId: "one", ordinal: 2 }] })
    expect(retried.stack.todos[0]).toMatchObject({ id: "one", position: 1, state: "working", attempt: 2 })
    expect(apply(retried.stack, { kind: "retry", number: 1 }).result).toEqual({ kind: "refused", code: "not_retryable" })
    expect(apply(retried.stack, { kind: "retry", number: 7 }).result).toEqual({ kind: "refused", code: "not_found" })
  })

  test("retry stacks on the nearest TODO its chain still has, past any whose pull request closed", () => {
    const todos = [
      row({ id: "a", number: 1, position: 1, state: "in_review", attempt: 1 }),
      row({ id: "b", number: 2, position: 2, state: "in_review", attempt: 1, after: "a", baseClosed: true }),
      row({ id: "c", number: 3, position: 3, state: "failed", attempt: 1, after: "b", baseClosed: true }),
    ]
    const retried = apply(stack({ nextNumber: 4, lanes: 1, todos }), { kind: "retry", number: 3 })
    expect(retried.stack.todos.find((todo) => todo.id === "c")).toMatchObject({ state: "working", after: "a", baseClosed: false })
    const orphan = apply(stack({ nextNumber: 4, lanes: 0, todos: [{ ...todos[2]!, after: "gone" }] }), { kind: "retry", number: 3 })
    expect(orphan.stack.todos[0]!.after).toBeNull()
  })

  test("a TODO stacked on one the stack doesn't hold never starts", () => {
    const todos = [row({ id: "b", number: 2, position: 1, after: "gone" })]
    expect(isReady(todos, todos[0]!)).toBe(false)
  })
})

describe("violations", () => {
  const row = (fields: Partial<Row> & Pick<Row, "id" | "number">): Row => ({
    state: "queued",
    position: 1,
    attempt: 0,
    revision: 1,
    after: null,
    ...fields,
  })
  const of = (nextNumber: number, todos: ReadonlyArray<Row>) => violations({ nextNumber, lanes: 1, maxOpen: 5, base: "stacked", todos })

  test("names each broken rule", () => {
    expect(of(2, [row({ id: "a", number: 1 })])).toEqual([])
    expect(of(3, [row({ id: "a", number: 1 }), row({ id: "b", number: 1, position: 2 })])).toEqual(["a number is taken twice"])
    expect(of(1, [row({ id: "a", number: 1 })])).toEqual(["a number outside 1 to next"])
    expect(of(3, [row({ id: "a", number: 1 }), row({ id: "b", number: 2, position: 3 })])).toEqual(["open positions aren't 1 to n"])
    expect(of(2, [row({ id: "a", number: 1, state: "dropped" })])).toEqual(["a settled TODO is placed, or an open one isn't"])
    expect(of(3, [row({ id: "a", number: 1, after: "b" }), row({ id: "b", number: 2, position: 2 })])).toEqual(["an after isn't an open TODO before it"])
    expect(of(3, [row({ id: "a", number: 1, position: null, state: "merged" }), row({ id: "b", number: 2, after: "a" })]))
      .toEqual(["an after isn't an open TODO before it"])
  })
})
