/**
 * The driver: one round of the queue against the world.
 *
 * A round does four things in order. It writes the changes the round before
 * ended into the record of endings. It makes the world match the queue's
 * state (`sync`): fast-forward the target onto the tree being pushed, keep
 * exactly the wanted CI runs and fix agents going. It reads what the world has
 * to say (`gather`), waiting when there is nothing new and nothing to decide.
 * It folds that into the state and lets the policy settle.
 *
 * A round returns the changes it ended and the next round records them, so
 * the record only ever holds an ending the host had already recorded as the
 * queue's decision. A round that ran twice after a crash may decide
 * differently the second time; only the decision that was kept is written.
 *
 * A round ends by cutting the parts of the target's tree that every run was
 * built on (`settled`, `cut`), and the next round begins by telling the
 * target to settle the same parts, so the trees in the state stay short.
 *
 * The round keeps only what the queue still needs: after every event it drops
 * the changes that ended and the landings (`runPruned`, `settlePruned`). They
 * are in the record of endings by the next round, so the state a host carries
 * holds only what is still in the queue, however long the queue has run.
 *
 * Every command is derived from the state alone, and a host records the state
 * between rounds (the flow in `QueueFlow.ts` does). So the target only ever
 * moves onto a tree a recorded decision pushed, and a crash anywhere repeats a
 * round whose commands are safe to repeat.
 *
 * The queue is rebased on the real tip of the target every round. The tip is
 * read, never assumed: a commit someone else put there becomes a `foreign`
 * event, every run on the old tip dies, and the stack is rebuilt on the new
 * tip and tested again, without the queue stopping.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { Config, Event, State, Tree } from "./Basic.ts"
import { isTerminal, sameTree, tree } from "./Basic.ts"
import { cut, runPruned, settled, settlePruned } from "./Compact.ts"
import type { FixBrief } from "./Policy.ts"
import { fixBriefs, plan, wantsCi } from "./Policy.ts"
import { eta, remaining } from "./Predict.ts"
import type { Ending, Job, Unavailable } from "./Services.ts"
import { Ci, Endings, Fixer, Inbox, Target, TargetDiverged } from "./Services.ts"
import { answered, pushingRun, strip } from "./Step.ts"

/**
 * What the queue carries from one round to the next.
 *
 * @category models
 * @since 0.1.0
 */
export interface Position {
  /** The queue's state, pruned: no ended change and no landing. */
  readonly state: State
  /** How many inbox letters the queue has taken. */
  readonly cursor: number
  /** Whether the inbox asked the queue to finish once every change has ended. */
  readonly closed: boolean
  /** The changes the round before ended. This round writes them into the record. */
  readonly ended: ReadonlyArray<Ending>
  /**
   * How many parts of the target's tree the queue has cut from its state since
   * it started. The state's trees are spoken of from there, and each round
   * first makes the target speak of them from there too.
   */
  readonly settled: number
}

/**
 * What the world must be made to do for a state. Every command is a
 * reconciliation, safe to issue again.
 *
 * @category models
 * @since 0.1.0
 */
export interface Commands {
  /** The parts the target must have settled, so that it speaks of the same trees as the state. */
  readonly settled: number
  /** The fast-forward under way: from the tip the run was tested on, to the tested tree. */
  readonly advance: { readonly from: Tree; readonly to: Tree } | null
  /** Exactly the CI runs that must be running. */
  readonly jobs: ReadonlyArray<Job>
  /** Exactly the fix agents that must be working, each with its failures so far. */
  readonly briefs: ReadonlyArray<FixBrief>
}

/**
 * The most policy decisions one round applies. A round that reaches it stops
 * deciding and the next round continues, so a round always ends.
 *
 * @category constants
 * @since 0.1.0
 */
export const settleFuel = 1024

/**
 * The CI job for a run: its tree, its remaining checks slowest first, and its
 * ETA. `from` is how many parts the queue has cut from the state's trees.
 *
 * @category commands
 * @since 0.1.0
 */
export const job = (config: Config, state: State, id: number, from = 0): Job | undefined => {
  const found = state.runs.find((entry) => entry.id === id)
  return found === undefined ? undefined : {
    run: found.id,
    from,
    tree: tree(found),
    checks: remaining(config, state.history, found.results),
    eta: eta(config, state.history, found.results)
  }
}

const wanted = (config: Config, state: State): ReadonlyArray<number> =>
  state.runs.filter((entry) => wantsCi(config, state, entry)).map((entry) => entry.id)

/**
 * The commands a state implies. `from` is how many parts the queue has cut
 * from the state's trees (`Position.settled`).
 *
 * @category commands
 * @since 0.1.0
 */
export const commands = (config: Config, state: State, from = 0): Commands => {
  const pushed = pushingRun(state)
  return {
    settled: from,
    advance: pushed === undefined ? null : { from: state.main, to: tree(pushed) },
    jobs: wanted(config, state).map((id) => job(config, state, id, from)!),
    briefs: fixBriefs(state)
  }
}

/**
 * Folds events into the pruned state and lets the policy settle, pruning after
 * every event. Returns the next pruned state and the changes that ended on the
 * way, in the order they ended.
 *
 * @category transitions
 * @since 0.1.0
 */
export const advance = (
  config: Config,
  state: State,
  events: ReadonlyArray<Event>
): { readonly state: State; readonly ended: ReadonlyArray<Ending> } => {
  const finished: Array<Ending> = []
  const dropped = (before: State, after: State): void => void finished.push(...ended(before, after))
  const folded = runPruned(config, state, events, dropped)
  return { state: settlePruned(config, settleFuel, folded, dropped), ended: finished }
}

/**
 * Whether the queue is finished: no run is left, and every change the state
 * holds has ended. A pruned state holds no ended change, so it is drained
 * when it holds no change at all.
 *
 * @category predicates
 * @since 0.1.0
 */
export const drained = (state: State): boolean =>
  state.runs.length === 0 && state.changes.every((change) => isTerminal(change.status))

/**
 * The changes that ended between two states of one queue, in the order the
 * queue holds them: every change that has ended in `after` and had not in
 * `before`. A merged change is given the landing that holds its revision.
 *
 * @category observation
 * @since 0.1.0
 */
export const ended = (before: State, after: State): ReadonlyArray<Ending> => {
  const open = new Set(before.changes.filter((change) => !isTerminal(change.status)).map((change) => change.id))
  const known = new Set(before.changes.map((change) => change.id))
  const landings = after.landed.slice(before.landed.length)
  return after.changes.flatMap((change): ReadonlyArray<Ending> => {
    const status = change.status
    if (status._tag === "queued" || status._tag === "fixing" || (known.has(change.id) && !open.has(change.id))) {
      return []
    }
    const landing = status._tag !== "merged"
      ? undefined
      : landings.find((entry) => entry.batch.some((part) => part.id === change.id && part.rev === change.rev))
    return [{
      id: change.id,
      rev: change.rev,
      attempts: change.attempts,
      status,
      landing: landing === undefined
        ? null
        : { run: landing.run, results: landing.results, foreign: landing.foreign }
    }]
  })
}

/**
 * What the tip of the target says, as events: the landing of the tree the
 * queue was pushing, and a `foreign` event for every commit someone else put
 * there. `undefined` when the tip does not extend the tree the queue knows.
 *
 * @category observation
 * @since 0.1.0
 */
export const tipEvents = (state: State, tip: Tree): ReadonlyArray<Event> | undefined => {
  const added = strip(state.main, tip)
  if (added === undefined) return undefined
  const pushed = pushingRun(state)
  const beyond = pushed === undefined || added.length === 0 ? undefined : strip(tree(pushed), tip)
  return [
    ...(beyond === undefined ? [] : [{ _tag: "land", run: pushed!.id } as const]),
    ...(beyond ?? added).map((entry) => ({ _tag: "foreign", id: entry.id }) as const)
  ]
}

/**
 * What the world has to say since the last round.
 *
 * @category models
 * @since 0.1.0
 */
export interface News {
  readonly events: ReadonlyArray<Event>
  readonly tip: Tree
  readonly cursor: number
  readonly closed: boolean
}

/**
 * Reads the world without waiting: the tip of the target, new inbox letters,
 * every check that finished on a run the queue is watching, runs CI lost, and
 * fix agents' answers.
 *
 * @category observation
 * @since 0.1.0
 */
export const gather = (
  config: Config,
  position: Position
): Effect.Effect<News, Unavailable | TargetDiverged, Inbox | Ci | Fixer | Target> =>
  Effect.gen(function*() {
    const inbox = yield* Inbox
    const ci = yield* Ci
    const fixer = yield* Fixer
    const target = yield* Target
    const { state } = position
    const tip = yield* target.tip
    const moved = tipEvents(state, tip)
    if (moved === undefined) return yield* new TargetDiverged({ known: state.main, found: tip })
    const events: Array<Event> = [...moved]
    const letters = yield* inbox.since(position.cursor)
    for (const letter of letters) if (letter._tag === "event") events.push(letter.event)
    for (const id of wanted(config, state)) {
      const entry = state.runs.find((candidate) => candidate.id === id)!
      const progress = yield* ci.progress(id)
      if (progress._tag === "lost") {
        events.push({ _tag: "cancel", run: id })
        continue
      }
      for (const finished of progress.finished) {
        if (!answered(entry.results, finished.check)) events.push({ _tag: "result", run: id, ...finished })
      }
    }
    for (const brief of fixBriefs(state)) {
      const answer = yield* fixer.answer(brief.id, brief.attempt)
      if (answer === undefined) continue
      events.push(
        answer._tag === "fixed"
          ? { _tag: "fixed", id: brief.id, attempt: brief.attempt }
          : { _tag: "gaveUp", id: brief.id, attempt: brief.attempt, detail: answer.detail }
      )
    }
    return {
      events,
      tip,
      cursor: position.cursor + letters.length,
      closed: position.closed || letters.some((letter) => letter._tag === "close")
    }
  })

/**
 * Waits until the world may have something new: a letter, a finished check, a
 * fix agent's answer or a moved target.
 *
 * @category observation
 * @since 0.1.0
 */
export const waitForNews = (
  config: Config,
  position: Position,
  tip: Tree
): Effect.Effect<void, never, Inbox | Ci | Fixer | Target> =>
  Effect.gen(function*() {
    const inbox = yield* Inbox
    const ci = yield* Ci
    const fixer = yield* Fixer
    const target = yield* Target
    const { state } = position
    const seen = wanted(config, state).map((id) => ({
      run: id,
      finished: state.runs.find((entry) => entry.id === id)!.results.length
    }))
    const pending = fixBriefs(state).map((brief) => ({ id: brief.id, attempt: brief.attempt }))
    yield* Effect.raceAll([
      inbox.wait(position.cursor),
      target.wait(tip),
      ...(seen.length === 0 ? [] : [ci.wait(seen)]),
      ...(pending.length === 0 ? [] : [fixer.wait(pending)])
    ])
  })

/**
 * Makes the world match a state: the parts the target has settled, the
 * fast-forward under way, the CI runs and the fix agents. Safe to run again.
 *
 * @category rounds
 * @since 0.1.0
 */
export const sync = (issued: Commands): Effect.Effect<void, Unavailable, Ci | Fixer | Target> =>
  Effect.gen(function*() {
    const target = yield* Target
    const ci = yield* Ci
    const fixer = yield* Fixer
    yield* target.settle(issued.settled)
    if (issued.advance !== null) yield* target.advance(issued.advance.from, issued.advance.to)
    yield* ci.reconcile(issued.jobs)
    yield* fixer.reconcile(issued.briefs)
  }).pipe(Effect.withSpan("merge-queue.sync"))

/**
 * The outcome of one round.
 *
 * @category models
 * @since 0.1.0
 */
export interface Outcome extends Position {
  /**
   * Whether the queue is finished: closed, every change ended, no run left,
   * every ending in the record and every cut told to the target. A round that
   * ends a change or cuts its trees is never the last one: the round after it
   * records the ending and has the target settle the parts.
   */
  readonly done: boolean
}

/**
 * One round: record the endings of the round before, sync the world to the
 * state, read the world (waiting when there is nothing new and nothing to
 * decide), fold and settle, and prune what ended.
 *
 * The round ends by checking the queue is on the target's tip: the state's
 * tree must be exactly the tree the target was read on. A round that cannot
 * explain the tip fails with {@link TargetDiverged} and changes nothing.
 *
 * @category rounds
 * @since 0.1.0
 */
export const round = (
  config: Config,
  position: Position
): Effect.Effect<Outcome, Unavailable | TargetDiverged, Inbox | Ci | Fixer | Target | Endings> =>
  Effect.gen(function*() {
    if (position.ended.length > 0) yield* (yield* Endings).record(position.ended)
    yield* sync(commands(config, position.state, position.settled))
    let news = yield* gather(config, position)
    const idle = news.events.length === 0 && news.closed === position.closed
      && plan(config, position.state) === undefined
    if (idle && !(position.closed && drained(position.state))) {
      yield* waitForNews(config, position, news.tip)
      news = yield* gather(config, position)
    }
    const { ended: finished, state: advanced } = advance(config, position.state, news.events)
    if (!sameTree(advanced.main, news.tip)) {
      return yield* new TargetDiverged({ known: advanced.main, found: news.tip })
    }
    // Every part that every run was built on is behind the queue for good. The
    // next round tells the target before it reads or moves it.
    const behind = settled(advanced)
    const state = cut(advanced, behind)
    yield* Effect.logInfo("merge queue round").pipe(
      Effect.annotateLogs({
        events: news.events.length,
        landings: new Set(finished.flatMap((ending) =>
          ending.landing === null
            ? []
            : [ending.landing.foreign ? `foreign ${ending.id}` : `run ${ending.landing.run}`]
        )).size,
        ended: finished.length,
        runs: state.runs.length,
        fixing: fixBriefs(state).length,
        main: state.main.length,
        settled: position.settled + behind
      })
    )
    return {
      state,
      cursor: news.cursor,
      closed: news.closed,
      ended: finished,
      settled: position.settled + behind,
      done: news.closed && drained(state) && finished.length === 0 && behind === 0
    }
  }).pipe(Effect.withSpan("merge-queue.round"))
