import { ACTIVE_STATES, LANE_STATES, SETTLED_STATES, type StackBase, type TodoState } from "./contract"

// The stack's rules (decision 0016 §1, decision 0135), as a pure function: what one change does to one repository's
// stack. The writer (worker/stack/Stack.ts) loads the stack inside its transaction, applies a change here, and writes
// back what changed, so these rules have one home, and the property tests (stack.test.ts) prove them over random
// sequences of changes.
//
// - A TODO's number counts per repository from 1 and is never reused.
// - The stack is the open TODOs (neither merged nor dropped) in `position` order; positions are always 1 to n.
// - A settled TODO has no position.
// - Dropping a dropped TODO changes nothing; a merged one can't be dropped.
// - A TODO's `after` names the open TODO it waits for and stacks on, always one before it, or none: it starts from the
//   default branch. A commit that names none takes the stack's `base`: `stacked`, the last open TODO; `independent`,
//   none.
// - At most `lanes` TODOs hold a lane (Working). A Queued TODO is ready when every TODO on its `after` chain is In
//   review; whenever a lane is free, the oldest ready TODOs start, the stacked ones on the branch of their `after`. A
//   host that runs no TODOs passes `lanes: 0`, and nothing starts.
// - A TODO that leaves the stack hands its `after` to the TODOs after it. One that leaves after publishing (In review)
//   fails its Queued ones `base_closed`: they asked for a change that won't merge. A failure holds only the TODOs whose
//   chain runs through it.

/** A TODO as the rules see it. */
export interface Row {
  readonly id: string
  readonly number: number
  readonly state: TodoState
  readonly position: number | null
  /** How many attempts it has had: its next one's ordinal is one more. */
  readonly attempt: number
  /** Its prompt's latest revision, which an attempt works on. */
  readonly revision: number
  /** The open TODO it waits for and stacks on, or none: it starts from the default branch. */
  readonly after: string | null
  /** Its pull request closed unmerged, or it failed `base_closed`: nothing may stack on it. */
  readonly baseClosed?: boolean
}

/** One repository's stack, as its writer loaded it under the lock. */
export interface Stack {
  /** The number its next TODO takes. */
  readonly nextNumber: number
  /** How many TODOs may work at once; 0 when this host runs no TODOs. */
  readonly lanes: number
  /** How many TODOs may be open at once. */
  readonly maxOpen: number
  /** Where a commit that names no `after` starts. */
  readonly base: StackBase
  /** Every open TODO, and any settled one a change names. */
  readonly todos: ReadonlyArray<Row>
}

/**
 * A change: append TODO `id` (after TODO number `after`, none for `null`, the stack's base when absent), drop TODO
 * `number`, retry failed TODO `number`, change the stack's settings, publish TODO `id`'s attempt `ordinal` (its pull
 * request is open, In review), or finish it as its run ended it (merged, closed on GitHub as dropped, or failed).
 */
export type Op =
  | { readonly kind: "commit"; readonly id: string; readonly after?: number | null }
  | { readonly kind: "drop"; readonly number: number }
  | { readonly kind: "retry"; readonly number: number }
  | { readonly kind: "configure"; readonly lanes: number; readonly maxOpen: number; readonly base: StackBase }
  | { readonly kind: "publish"; readonly id: string; readonly ordinal: number }
  | { readonly kind: "finish"; readonly id: string; readonly ordinal: number; readonly state: FinishedState }

/** How a run ends its TODO. */
export type FinishedState = "merged" | "dropped" | "failed"

/** A TODO that starts an attempt: its run's key is the attempt the writer records for it. */
export interface Start {
  readonly todoId: string
  readonly number: number
  /** The attempt's ordinal: 1 for a TODO's first. */
  readonly ordinal: number
  readonly revision: number
}

/** What a change did, or why the stack refused it. */
export type Result =
  | {
    readonly kind: "committed"
    readonly number: number
    readonly position: number
    readonly starts: ReadonlyArray<Start>
  }
  | {
    readonly kind: "dropped"
    readonly number: number
    /** False when it was dropped already: the change changed nothing. */
    readonly changed: boolean
    /** The TODO's attempt, when it held a lane: its run must stop. */
    readonly stopped: { readonly todoId: string; readonly ordinal: number } | undefined
    readonly starts: ReadonlyArray<Start>
  }
  | {
    readonly kind: "published"
    readonly number: number
    readonly starts: ReadonlyArray<Start>
  }
  | {
    readonly kind: "finished"
    readonly number: number
    readonly state: FinishedState
    readonly starts: ReadonlyArray<Start>
  }
  | { readonly kind: "retried"; readonly number: number; readonly starts: ReadonlyArray<Start> }
  | { readonly kind: "configured"; readonly starts: ReadonlyArray<Start> }
  | {
    readonly kind: "refused"
    readonly code: "stack_full" | "merged" | "not_found" | "stale" | "not_retryable" | "after_not_open"
  }

const settled = (state: TodoState): boolean => (SETTLED_STATES as ReadonlyArray<TodoState>).includes(state)
const inLane = (state: TodoState): boolean => (LANE_STATES as ReadonlyArray<TodoState>).includes(state)
const active = (state: TodoState): boolean => (ACTIVE_STATES as ReadonlyArray<TodoState>).includes(state)

/** The open TODOs, in stack order. */
export const openOf = (stack: Stack): ReadonlyArray<Row> => byPosition(stack.todos)

/** `todos`' placed ones, by position. */
const byPosition = (todos: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  todos.filter((todo) => todo.position !== null).sort((a, b) => a.position! - b.position!)

/**
 * Whether every TODO on the chain from `after` is In review with its pull request open: what a TODO stacked there
 * needs before it starts. An empty chain is ready; a TODO the stack doesn't hold is not.
 */
const chainReady = (todos: ReadonlyArray<Row>, after: string | null): boolean => {
  const seen = new Set<string>()
  for (let id = after; id !== null;) {
    const row = todos.find((todo) => todo.id === id)
    if (row === undefined || seen.has(id) || row.state !== "in_review" || row.baseClosed === true) return false
    seen.add(id)
    id = row.after
  }
  return true
}

/** Whether `todo` may start now: Queued, with every TODO it stacks on In review. */
export const isReady = (todos: ReadonlyArray<Row>, todo: Row): boolean =>
  todo.state === "queued" && chainReady(todos, todo.after)

/** Starts the oldest ready TODOs while a lane is free. */
const fill = (todos: ReadonlyArray<Row>, lanes: number): { todos: ReadonlyArray<Row>; starts: ReadonlyArray<Start> } => {
  const free = lanes - todos.filter((todo) => inLane(todo.state)).length
  const ready = byPosition(todos).filter((todo) => isReady(todos, todo))
  const starting = new Set(ready.slice(0, Math.max(0, free)).map((todo) => todo.id))
  const starts: Array<Start> = []
  const next = todos.map((todo) => {
    if (!starting.has(todo.id)) return todo
    const ordinal = todo.attempt + 1
    starts.push({ todoId: todo.id, number: todo.number, ordinal, revision: todo.revision })
    return { ...todo, state: "working" as const, attempt: ordinal }
  })
  return { todos: next, starts }
}

/**
 * TODO `target` leaves the stack as `state`: unplaced, the gap closed, and the TODOs after it handed its own `after`.
 * When it leaves unmerged after publishing (`published`), the Queued ones fail `base_closed`; those already running
 * learn it from their own run (worker/flows/TodoBaseClosed.ts).
 */
const leave = (todos: ReadonlyArray<Row>, target: Row, state: "merged" | "dropped", published: boolean): ReadonlyArray<Row> =>
  todos.map((todo): Row => {
    if (todo.id === target.id) return { ...todo, state, position: null }
    const moved = todo.position !== null && todo.position > target.position! ? { ...todo, position: todo.position - 1 } : todo
    if (todo.after !== target.id) return moved
    return { ...moved, after: target.after, state: published && todo.state === "queued" ? "failed" : todo.state }
  })

/** The nearest TODO on `after`'s chain that nothing closed: where a retried TODO stacks. */
const nearestOpen = (todos: ReadonlyArray<Row>, after: string | null): string | null => {
  for (let id = after, steps = 0; id !== null && steps <= todos.length; steps++) {
    const row = todos.find((todo) => todo.id === id)
    if (row === undefined) return null
    if (row.baseClosed !== true) return id
    id = row.after
  }
  return null
}

/** Applies `op` to `stack`: the stack after it, and what it did. A refused change leaves the stack as it was. */
export const apply = (stack: Stack, op: Op): { readonly stack: Stack; readonly result: Result } => {
  const open = openOf(stack)
  if (op.kind === "commit") {
    if (open.length >= stack.maxOpen) return { stack, result: { kind: "refused", code: "stack_full" } }
    const named = op.after === undefined || op.after === null ? undefined : open.find((todo) => todo.number === op.after)
    if (op.after !== undefined && op.after !== null && named === undefined) {
      return { stack, result: { kind: "refused", code: "after_not_open" } }
    }
    const after = op.after === undefined
      ? (stack.base === "stacked" ? open.at(-1)?.id ?? null : null)
      : named?.id ?? null
    const todo: Row = {
      id: op.id,
      number: stack.nextNumber,
      state: "queued",
      position: open.length + 1,
      attempt: 0,
      revision: 1,
      after,
    }
    const filled = fill([...stack.todos, todo], stack.lanes)
    return {
      stack: { ...stack, nextNumber: stack.nextNumber + 1, todos: filled.todos },
      result: { kind: "committed", number: todo.number, position: todo.position!, starts: filled.starts },
    }
  }
  if (op.kind === "configure") {
    const filled = fill(stack.todos, op.lanes)
    return {
      stack: { ...stack, lanes: op.lanes, maxOpen: op.maxOpen, base: op.base, todos: filled.todos },
      result: { kind: "configured", starts: filled.starts },
    }
  }
  if (op.kind === "finish") return finish(stack, op)
  if (op.kind === "publish") return publish(stack, op)
  const target = stack.todos.find((todo) => todo.number === op.number)
  if (target === undefined) return { stack, result: { kind: "refused", code: "not_found" } }
  if (op.kind === "retry") {
    if (target.state !== "failed") return { stack, result: { kind: "refused", code: "not_retryable" } }
    // It stacks again on the nearest TODO its chain still has: past any whose pull request closed unmerged.
    const after = nearestOpen(stack.todos, target.after)
    const filled = fill(
      stack.todos.map((todo) => todo.id === target.id ? { ...todo, state: "queued" as const, baseClosed: false, after } : todo),
      stack.lanes,
    )
    return { stack: { ...stack, todos: filled.todos }, result: { kind: "retried", number: target.number, starts: filled.starts } }
  }
  if (target.state === "merged") return { stack, result: { kind: "refused", code: "merged" } }
  if (target.state === "dropped") {
    return { stack, result: { kind: "dropped", number: op.number, changed: false, stopped: undefined, starts: [] } }
  }
  const filled = fill(leave(stack.todos, target, "dropped", target.state === "in_review"), stack.lanes)
  return {
    stack: { ...stack, todos: filled.todos },
    result: {
      kind: "dropped",
      number: op.number,
      changed: true,
      stopped: active(target.state) ? { todoId: target.id, ordinal: target.attempt } : undefined,
      starts: filled.starts,
    },
  }
}

/** Whether `op` names a TODO whose live attempt is `op.ordinal`: else a dropped TODO's run, or an earlier attempt's. */
const liveTarget = (stack: Stack, op: { readonly id: string; readonly ordinal: number }): Row | undefined => {
  const target = stack.todos.find((todo) => todo.id === op.id)
  return target === undefined || !active(target.state) || target.attempt !== op.ordinal ? undefined : target
}

/**
 * A run published TODO `op.id`'s pull request: In review, its lane free for the oldest ready TODO, and the TODOs
 * stacked on it ready. Published again (a new head after it took in the TODO below it) changes nothing. A stale attempt
 * is refused.
 */
const publish = (stack: Stack, op: Extract<Op, { readonly kind: "publish" }>): { readonly stack: Stack; readonly result: Result } => {
  const target = liveTarget(stack, op)
  if (target === undefined) return { stack, result: { kind: "refused", code: "stale" } }
  const changed = stack.todos.map((todo): Row => (todo.id === target.id ? { ...todo, state: "in_review" } : todo))
  const filled = fill(changed, stack.lanes)
  return {
    stack: { ...stack, todos: filled.todos },
    result: { kind: "published", number: target.number, starts: filled.starts },
  }
}

/**
 * A run ends TODO `op.id`'s attempt: only while that attempt is live, Working or In review (a dropped TODO's run, or an
 * earlier attempt's, is `stale`). Merged and dropped leave the stack; failed keeps its place and holds the TODOs
 * stacked on it. A Working TODO's lane frees.
 */
const finish = (stack: Stack, op: Extract<Op, { readonly kind: "finish" }>): { readonly stack: Stack; readonly result: Result } => {
  const target = liveTarget(stack, op)
  if (target === undefined) return { stack, result: { kind: "refused", code: "stale" } }
  const changed = op.state === "failed"
    ? stack.todos.map((todo): Row => (todo.id === target.id ? { ...todo, state: "failed" } : todo))
    // A run reports dropped only for a pull request closed unmerged: the TODOs queued on it asked for that change.
    : leave(stack.todos, target, op.state, op.state === "dropped")
  const filled = fill(changed, stack.lanes)
  return {
    stack: { ...stack, todos: filled.todos },
    result: { kind: "finished", number: target.number, state: op.state, starts: filled.starts },
  }
}

/**
 * What a stack's rules forbid, as one line each; none for a stack that keeps them: unique numbers below `nextNumber`,
 * open positions exactly 1 to n, settled TODOs unplaced and open ones placed, and every open TODO's `after` an open
 * TODO before it. The limits are the changes' to keep: a person may lower `lanes` or `max_open` below what is in use.
 */
export const violations = (stack: Stack): ReadonlyArray<string> => {
  const found: Array<string> = []
  const numbers = stack.todos.map((todo) => todo.number)
  if (new Set(numbers).size !== numbers.length) found.push("a number is taken twice")
  if (numbers.some((number) => number < 1 || number >= stack.nextNumber)) found.push("a number outside 1 to next")
  const open = openOf(stack)
  if (open.some((todo, index) => todo.position !== index + 1)) found.push("open positions aren't 1 to n")
  if (stack.todos.some((todo) => settled(todo.state) !== (todo.position === null))) {
    found.push("a settled TODO is placed, or an open one isn't")
  }
  if (open.some((todo) => todo.after !== null && !open.some((before) => before.id === todo.after && before.position! < todo.position!))) {
    found.push("an after isn't an open TODO before it")
  }
  return found
}
