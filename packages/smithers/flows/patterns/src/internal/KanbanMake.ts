/**
 * The declaration side of `Kanban`: its types and `make`, which throws a
 * `PatternError` for a declaration it cannot build. `Kanban.vibe`
 * re-exports all of it beside `run`, the pattern's Effect form.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"
import * as Quarantine from "../Quarantine.vibe"
import * as Compose from "./Compose.ts"
import * as FailureSchema from "./Failure.ts"
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"
import { OpaqueInput } from "./Payload.ts"

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
export interface Column<R = never> {
  readonly name: string
  readonly flow: Member<R>
}

/**
 * The declared form of a board.
 *
 * @category models
 * @since 0.1.0
 */
export type KanbanFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly columns: ReadonlyArray<Column<R>>
  readonly items: ReadonlyArray<Item>
  readonly concurrency: number
  readonly onComplete?: Member<R> | undefined
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

/**
 * Shared with the Effect forms in the public module.
 *
 * @since 0.1.0
 * @private
 * @throws {never}
 */
export const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const completionBoard = (
  outcomes: ReadonlyArray<unknown>,
  ids: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  wire: (error: unknown) => unknown
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
        // The board is what the flow settles with, so a rejection is data.
        failed.push({ id, column, error: wire(outcome.error) })
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
 * The flow settles to the {@link Board} of its one pass, the record {@link run}
 * returns with `iterations: 1`. `onComplete` receives `{ items, board }` and
 * its own answer is discarded, as in `run`.
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
 * A later column's call for a card is the live arm of a `Node.branch` on the
 * real set of rejected cards, so a card an earlier column rejected makes no
 * further call, exactly as in `run`. The declared call count is therefore an
 * upper bound on a pass, and the calls an executed declaration makes are the
 * calls `run` makes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): KanbanFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. An item record is
  // copied because it enters key material as a literal.
  const columns: ReadonlyArray<Column<R>> = options.columns.map((column) => ({
    name: column.name,
    flow: column.flow
  }))
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
  const wire = FailureSchema.wire(columns.map((column) => column.flow))
  // What one column hands the next: each live card's latest output, and every
  // card a column has rejected so far.
  const advance = (values: unknown, rejected: ReadonlyArray<string>): Carried => {
    const outcomes = values as Readonly<Record<string, Quarantine.Settled<unknown, unknown>>>
    // Entries, not assignment: an item id such as `__proto__` is an own key.
    const previous: Array<readonly [string, unknown]> = []
    const still: Array<string> = [...rejected]
    for (const id of ids) {
      if (rejected.includes(id)) continue
      const outcome = outcomes[id]!
      if (outcome._tag === "Succeeded") previous.push([id, outcome.value])
      else still.push(id)
    }
    return { previous: Object.fromEntries(previous), rejected: still }
  }
  const column = (index: number, carried: Planned.Planned<Carried> | undefined): Node.Node<unknown, unknown, R> => {
    const declared = columns[index]!
    const call = (item: Item, previous: unknown): Node.Node<unknown, unknown, R> =>
      callMember(declared.flow, { column: declared.name, item, previous })
    // A card an earlier column rejected makes no call here, as in `run`: the
    // call is the live arm of a branch on the real rejected set. The skipped
    // arm's value is never read, because the board fold drops a rejected card
    // from every later column.
    const card = (item: Item): Node.Node<unknown, unknown, R> =>
      carried === undefined ? call(item, undefined) : Node.branch(Node.succeed(carried.rejected), {
        if: Node.capture(
          { column: declared.name, item: item.id },
          (rejected: ReadonlyArray<string>) => !rejected.includes(item.id)
        ),
        then: () => call(item, (carried.previous as Readonly<Record<string, unknown>>)[item.id]),
        else: () => Node.succeed(null)
      })
    const batchAt = (offset: number): Node.Node<unknown, unknown, R> => {
      const members = Object.fromEntries(
        items.slice(offset, offset + concurrency).map((item) => [item.id, card(item)])
      ) as Record<string, Node.Any>
      return Quarantine.all(members, { policy: "quarantine" })
    }
    const visit = (
      offset: number,
      gathered: Readonly<Record<string, Planned.Planned<unknown>>>
    ): Node.Node<unknown, unknown, R> => {
      if (offset >= items.length) return Node.succeed(gathered)
      const batched = ids.slice(offset, offset + concurrency)
      return Node.bindPlanned(
        batchAt(offset),
        Node.capture({ column: declared.name, offset, batched }, (reference) =>
          Node.andThen(
            Node.succeed(reference),
            visit(offset + concurrency, {
              ...gathered,
              ...Object.fromEntries(
                batched.map((id) => [id, (reference as Readonly<Record<string, Planned.Planned<unknown>>>)[id]!])
              )
            })
          ))
      )
    }
    return visit(0, {})
  }
  const { name, description } = Compose.label("kanban", { columns: names, items: ids.length, concurrency }, options, [
    ...columns.map((column) => column.flow),
    onComplete
  ])
  const body = (): Node.Node<unknown, unknown, R> => {
    const walk = (
      index: number,
      carried: Planned.Planned<Carried> | undefined,
      history: ReadonlyArray<unknown>
    ): Node.Node<unknown, unknown, R> =>
      Node.bindPlanned(
        column(index, carried),
        Node.capture({ ...captures, column: names[index] }, (values) => {
          const outcomes = [...history, values]
          if (index + 1 < columns.length) {
            const next = Node.map(
              Node.succeed({ values, rejected: carried === undefined ? [] : carried.rejected }),
              Node.capture(captures, (state: { readonly values: unknown; readonly rejected: ReadonlyArray<string> }) =>
                advance(state.values, state.rejected))
            )
            return Node.bindPlanned(
              next,
              Node.capture(
                { ...captures, column: names[index + 1] },
                (state: Planned.Planned<Carried>) =>
                  walk(index + 1, state, outcomes)
              )
            )
          }
          // The board is the same {@link Board} `run` returns for one pass.
          // `onComplete` sees it and its own answer is discarded, as in `run`.
          const board = Node.map(
            Node.succeed(outcomes),
            Node.capture(captures, (settled) =>
              completionBoard(settled as ReadonlyArray<unknown>, ids, names, wire))
          )
          if (onComplete === undefined) return board
          return Node.bindPlanned(
            board,
            Node.capture(captures, (settled) =>
              Node.andThen(callMember(onComplete, { items, board: settled }), Node.succeed(settled)))
          )
        })
      )
    return walk(0, undefined, [])
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // The engine encodes a typed failure through this schema: the pattern's
    // own `PatternError`, and whatever a member it called failed with.
    error: FailureSchema.schemaFor(
      [PatternError],
      [...columns.map((column) => column.flow), onComplete]
    ) as typeof Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

interface Carried {
  readonly previous: Readonly<Record<string, unknown>>
  readonly rejected: ReadonlyArray<string>
}
