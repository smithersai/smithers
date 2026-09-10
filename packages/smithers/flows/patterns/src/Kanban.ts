/**
 * Kanban pattern: move every item through an ordered list of columns, with a
 * concurrency bound applied inside each column.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"
import * as Quarantine from "./Quarantine.ts"

/**
 * One card on the board.
 *
 * `id` is the identity a column call, a board row, and a failure entry all use,
 * so it must be unique across the declared items.
 *
 * @category models
 * @since 0.1.0
 */
export interface Item {
  readonly id: string
}

/**
 * One declared column.
 *
 * @category models
 * @since 0.1.0
 */
export interface Column {
  readonly name: string
  readonly flow: Flow.Any
}

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly columns: ReadonlyArray<Column>
  readonly items: ReadonlyArray<Item>
  readonly concurrency: number
  readonly onComplete?: Flow.Any | undefined
}

/**
 * One column at runtime.
 *
 * `previous` is the value the same item produced in the preceding column, and
 * is `undefined` in the first column.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeColumn<It extends Item, Out, E, R> {
  readonly name: string
  readonly run: (args: {
    readonly item: It
    readonly column: string
    readonly previous: Out | undefined
  }) => Effect.Effect<Out, E, R>
}

/**
 * One item that a column rejected.
 *
 * @category models
 * @since 0.1.0
 */
export interface Failure<E> {
  readonly id: string
  readonly column: string
  readonly error: E
}

/**
 * The state of the board after a pass.
 *
 * `board` holds one row per item that cleared at least one column, keyed by
 * item id then column name. `completed` lists the items that cleared every
 * column, in declaration order. `failed` lists the column that rejected an item
 * and the error it raised.
 *
 * @category models
 * @since 0.1.0
 */
export interface Board<Out, E> {
  readonly board: Record<string, Record<string, Out>>
  readonly completed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<Failure<E>>
  readonly iterations: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * `maxIterations` is the number of passes the board runs, and defaults to one.
 * `until` stops it early, after the pass whose result satisfies the predicate,
 * and requires `maxIterations`, because a predicate that never holds would
 * otherwise run forever.
 * `run` snapshots `items`, `columns`, and every option at the call and reads
 * each item's `id` once there, so a later edit to the arrays or the option
 * object does not alter that run. The item record itself is handed to the
 * column as the caller's own object. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<It extends Item, Out, E, R, E2 = never, R2 = never> {
  readonly columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>
  readonly concurrency: number
  /**
   * Runs once after the final pass with the original items and final board.
   * A failure from this callback is the run's failure.
   */
  readonly onComplete?:
    | ((args: {
      readonly items: ReadonlyArray<It>
      readonly board: Board<Out, E>
    }) => Effect.Effect<unknown, E2, R2>)
    | undefined
  readonly until?: ((board: Board<Out, E>) => boolean) | undefined
  readonly maxIterations?: number | undefined
}

const merge = (left: unknown, right: unknown): Record<string, unknown> => ({
  ...(left as Record<string, unknown>),
  ...(right as Record<string, unknown>)
})

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const completionBoard = (
  outcomes: ReadonlyArray<unknown>,
  ids: ReadonlyArray<string>,
  names: ReadonlyArray<string>
): Board<unknown, unknown> => {
  const board = new Map<string, Record<string, unknown>>()
  const failed: Array<Failure<unknown>> = []
  const rejected = new Set<string>()
  for (const [index, values] of outcomes.entries()) {
    const column = names[index]!
    for (const id of ids) {
      // Later calls remain in the declaration, but a failed card cannot
      // become completed just because one of those calls accepted its marker.
      if (rejected.has(id)) continue
      const outcome = (values as Record<string, Quarantine.Settled<unknown, unknown>>)[id]!
      if (outcome._tag === "Succeeded") {
        board.set(id, { ...board.get(id), [column]: outcome.value })
      } else {
        rejected.add(id)
        failed.push({ id, column, error: outcome.error })
      }
    }
  }
  return {
    board: Object.fromEntries(board),
    completed: ids.filter((id) => !rejected.has(id)),
    failed,
    iterations: 1
  }
}

/**
 * Builds the board topology: for each column in order, one call per item,
 * batched into `Node.all` groups of `concurrency` members, with the batches
 * sequenced so the plan never admits more parallel calls than the bound.
 *
 * Each call receives `{ column, item, previous }`. `previous` refers to the
 * same item's result in the preceding column, so a built graph shows the
 * per-item chain across columns rather than a column-wide barrier of values.
 * `onComplete` receives `{ items, board }`, where `board` is a {@link Board}
 * containing every column result and `iterations: 1` for the declared pass.
 * The columns themselves are sequenced: a column's first call depends on the
 * whole preceding column.
 *
 * `make` throws a `PatternError` when there are no columns, no items, a
 * duplicate item id, duplicate column name, or a concurrency that is not a
 * positive safe integer.
 *
 * `make` snapshots `columns`, `items`, and every option at the call, copying
 * each item record, so a later edit to the caller's arrays or records does
 * not change the declaration.
 *
 * A column joins its batch with {@link Quarantine.all} under the `quarantine`
 * policy, because one rejected card is not a reason to interrupt the cards
 * beside it, which is the same call {@link run} makes. A rejected card
 * settles as a {@link Quarantine.Quarantined} marker naming the item.
 *
 * The declaration does not drop a quarantined card from the later columns: a
 * plan has no branch, so the card travels on with its marker as `previous` and
 * the column flow decides what a quarantined predecessor means. `run` has the
 * value in hand and does drop it. The two paths therefore differ in WHICH
 * calls happen and not only in how many: an executed declaration calls the
 * later columns for a quarantined card where a `run` pass makes no call at
 * all, so a board's declared call count is an upper bound on a pass, and a
 * column flow reached through the declaration must read its `previous` for a
 * {@link Quarantine.Quarantined} marker.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. An item record is
  // copied because it enters key material as a literal.
  const columns: ReadonlyArray<Column> = options.columns.map((column) => ({ name: column.name, flow: column.flow }))
  const items: ReadonlyArray<Item> = options.items.map((item) => ({ ...item }))
  const concurrency = options.concurrency
  const onComplete = options.onComplete
  if (columns.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" })
  }
  if (items.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one item" })
  }
  if (!bound(concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Kanban concurrency must be a positive safe integer"
    })
  }
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" })
  }
  const names = columns.map((column) => column.name)
  if (new Set(names).size !== names.length) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban column names must be unique" })
  }
  const captures = { columns: names, items: ids, concurrency }
  const column = (index: number, previous: unknown): Node.Node<unknown, unknown> => {
    const declared = columns[index]!
    const batchAt = (offset: number): Node.Node<unknown, unknown> => {
      const members = Object.fromEntries(
        items.slice(offset, offset + concurrency).map((item) => [
          item.id,
          Compose.call(declared.flow, {
            column: declared.name,
            item,
            previous: previous === undefined ? undefined : (previous as Record<string, unknown>)[item.id]
          })
        ])
      ) as Record<string, Node.Any>
      return Quarantine.all(members, { policy: "quarantine" })
    }
    let batches = batchAt(0)
    for (let offset = concurrency; offset < items.length; offset += concurrency) {
      const batch = batchAt(offset)
      batches = Node.andThen(
        batches,
        Node.capture({ column: declared.name, offset }, (soFar) =>
          Node.map(
            batch,
            Node.capture({ column: declared.name, offset }, (values) => merge(soFar, values))
          ))
      )
    }
    return batches
  }
  const { name, description } = Compose.label("kanban", { columns: names, items: ids.length, concurrency }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: onComplete === undefined
      ? columns.map((declared) => declared.flow)
      : [...columns.map((declared) => declared.flow), onComplete],
    body: Node.capture(captures, () => {
      const walk = (
        index: number,
        previous: unknown,
        history: ReadonlyArray<unknown>
      ): Node.Node<unknown, unknown> => {
        const current = column(index, previous)
        if (index + 1 < columns.length) {
          // Unwrap inside a map, where outcomes are real values. A builder
          // continuation sees symbolic references while the graph is planned.
          const settled = Node.map(
            current,
            Node.capture(captures, (values) => ({
              outcomes: values,
              previous: Object.fromEntries(
                Object.entries(values as Record<string, Quarantine.Settled<unknown, unknown>>).map(([id, outcome]) => [
                  id,
                  outcome._tag === "Succeeded" ? outcome.value : outcome
                ])
              )
            }))
          )
          return Node.andThen(
            settled,
            Node.capture(
              { ...captures, column: names[index + 1] },
              (state) => walk(index + 1, state.previous, [...history, state.outcomes])
            )
          )
        }
        if (onComplete === undefined) return current
        return Node.andThen(
          Node.map(current, Node.capture(captures, (values) => completionBoard([...history, values], ids, names))),
          Node.capture(captures, (board) => Compose.call(onComplete, { items, board }))
        )
      }
      return walk(0, undefined, [])
    })
  })
}

// A card pairs the id `run` read at the call with the caller's own item
// record, so the board is keyed by a name that cannot move under it while the
// column still receives the object the caller handed over.
interface Card<It> {
  readonly id: string
  readonly item: It
}

const pass = <It extends Item, Out, E, R>(
  cards: ReadonlyArray<Card<It>>,
  columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>,
  concurrency: number
): Effect.Effect<Omit<Board<Out, E>, "iterations">, never, R> =>
  Effect.gen(function*() {
    const board = new Map<string, Map<string, Out>>()
    const failed: Array<Failure<E>> = []
    const latest = new Map<string, Out>()
    let active: ReadonlyArray<Card<It>> = cards
    for (const column of columns) {
      const outcomes = yield* Effect.forEach(
        active,
        (card) =>
          column.run({ item: card.item, column: column.name, previous: latest.get(card.id) }).pipe(
            Effect.map((output) => ({ ok: true, card, output } as const)),
            Effect.catch((error: E) => Effect.succeed({ ok: false, card, error } as const))
          ),
        { concurrency }
      )
      const next: Array<Card<It>> = []
      for (const outcome of outcomes) {
        if (outcome.ok) {
          const row = board.get(outcome.card.id) ?? new Map<string, Out>()
          row.set(column.name, outcome.output)
          board.set(outcome.card.id, row)
          latest.set(outcome.card.id, outcome.output)
          next.push(outcome.card)
        } else {
          failed.push({ id: outcome.card.id, column: column.name, error: outcome.error })
        }
      }
      active = next
    }
    return {
      board: Object.fromEntries(
        Array.from(board, ([id, columns]) => [id, Object.fromEntries(columns)])
      ),
      completed: active.map((card) => card.id),
      failed
    }
  })

/**
 * Moves every item through the columns in order.
 *
 * A column runs its items with `Effect.forEach` at `concurrency`, so at most
 * `concurrency` items are in flight in that column, and a column starts only
 * after the preceding column has settled for every item. An item a column
 * rejects is dropped from the board and listed in `failed`; the other items
 * keep moving. A column rejects an item by failing on the typed channel: a
 * card that throws raises a defect, which fails the pass and cancels the
 * cards beside it.
 *
 * The board runs `maxIterations` passes over the same items, one when the
 * option is absent. The old `<Kanban>` component defaulted that bound to five,
 * so a port that relied on the default must pass `maxIterations: 5`. `until`
 * stops the board early after the pass whose result satisfies the predicate. Each pass starts from an empty board, and the
 * returned board is the last pass's.
 *
 * `run` fails with a `PatternError` when two items share an id: the board is
 * keyed by item id, so a repeated id would run the same id twice and report
 * one row for both.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <It extends Item, Out, E = never, R = never, E2 = never, R2 = never>(
  items: ReadonlyArray<It>,
  options: RuntimeOptions<It, Out, E, R, E2, R2>
): Effect.Effect<Board<Out, E>, PatternError | E2, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the arrays or the option object in between must not reach it.
  // Each item's id is read once here; the record itself stays the caller's.
  const columns = options.columns.map((column) => ({ name: column.name, run: column.run }))
  const cards = items.map((item): Card<It> => ({ id: item.id, item }))
  const snapshot: ReadonlyArray<It> = cards.map((card) => card.item)
  const concurrency = options.concurrency
  const until = options.until
  const onComplete = options.onComplete
  const maxIterations = options.maxIterations
  if (columns.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" }))
  }
  if (cards.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one item" }))
  }
  if (!bound(concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban concurrency must be a positive safe integer"
      })
    )
  }
  const ids = cards.map((card) => card.id)
  if (new Set(ids).size !== ids.length) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" }))
  }
  const names = columns.map((column) => column.name)
  if (new Set(names).size !== names.length) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban column names must be unique" }))
  }
  if (until !== undefined && maxIterations === undefined) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban until requires maxIterations"
      })
    )
  }
  if (maxIterations !== undefined && !bound(maxIterations)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban maxIterations must be a positive safe integer"
      })
    )
  }
  const limit = maxIterations ?? 1
  return Effect.gen(function*() {
    let iterations = 0
    for (;;) {
      const settled = yield* pass(cards, columns, concurrency)
      iterations += 1
      const result: Board<Out, E> = { ...settled, iterations }
      const done = until !== undefined && until(result)
      if (done || iterations >= limit) {
        if (onComplete !== undefined) yield* onComplete({ items: snapshot, board: result })
        return result
      }
    }
  })
}
