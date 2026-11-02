/**
 * First red across a long stack: run the slow checks on the newest tip, and
 * for each check that fails there, find the earliest Change that breaks it.
 *
 * The range runs from the last green Change to the tip, in stack order, and
 * may hold Changes from many authors. Each failing check is rerun at the tip
 * to separate a real break from a flake, run once at the last green, then
 * bisected by Change. Only the failing checks run again. Every probe is an
 * ordinary `coding/check` call, so receipts bind the exact JJ commit, tree and
 * input digest, and the engine journals each one. Each round is one trampoline round; the cursor is its
 * whole state. See first-red.md.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { atomError } from "./atoms.ts"
import { Check, CodingError, Finding, Implementation, Receipt, receiptMatches } from "./schema.ts"
import { RunCheck } from "./workflow.ts"

const Id = Check.fields.id
/** The most Changes one search takes, the last green included. */
export const maximumRange = 256
/** The most runs at the tip before a failing check counts as broken. */
export const maximumTries = 5

export const FirstRedInput = Schema.Struct({
  // The last green Change first, the newest tip last; one parent chain.
  range: Schema.Array(Implementation).check(Schema.isMinLength(2), Schema.isMaxLength(maximumRange)),
  // The checks to run at the tip; only the ones that fail there run again.
  checks: Schema.Array(Check).check(Schema.isMinLength(1)),
  // Runs at the tip before a failing check counts as broken; 2 by default.
  tries: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumTries })))
})
export type FirstRedInput = typeof FirstRedInput.Type

const Open = Schema.Literals(["tip", "reproduce", "good", "bisect"])
/**
 * `broken`: fails every try at the tip, passes at the last green, first fails
 * at `change`. `flaky`: failed at the tip, then passed there. `broken-at-good`:
 * fails at the last green too. `untestable`: an infrastructure fault kept the
 * check from measuring the tip's first run or the last green, so nothing is
 * blamed. `passed`: passed at the tip.
 */
export const Verdict = Schema.Literals(["broken", "flaky", "broken-at-good", "untestable", "passed"])
export type Verdict = typeof Verdict.Type

/** One check's search: an open phase, or its verdict. Indexes point into the range. */
export const CheckSearch = Schema.Struct({
  checkId: Id,
  state: Schema.Union([Open, Verdict]),
  // Highest index known to pass and lowest known to fail.
  pass: Schema.Int,
  fail: Schema.Int,
  // Failed runs at the tip so far.
  failures: Schema.Int,
  // Indexes the check could not measure (an infrastructure fault), as `git bisect skip`.
  skipped: Schema.Array(Schema.Int),
  passing: Schema.NullOr(Receipt),
  failing: Schema.NullOr(Receipt),
  runs: Schema.Int
})
export type CheckSearch = typeof CheckSearch.Type

export const FirstRedCursor = Schema.Struct({
  range: FirstRedInput.fields.range,
  checks: FirstRedInput.fields.checks,
  tries: Schema.Int,
  searches: Schema.Array(CheckSearch)
})
export type FirstRedCursor = typeof FirstRedCursor.Type

export const FirstRedCheck = Schema.Struct({
  checkId: Id,
  target: Schema.NonEmptyString,
  verdict: Verdict,
  // `broken`: the first failing Change; otherwise null.
  change: Schema.NullOr(Id),
  // `broken`: untestable Changes between the last pass and `change`; any of them may be the first red instead.
  candidates: Schema.Array(Id),
  // The receipt at `change` (or the tip) and at the nearest passing Change below it, when measured.
  failing: Schema.NullOr(Receipt),
  passing: Schema.NullOr(Receipt),
  runs: Schema.Int
})
export type FirstRedCheck = typeof FirstRedCheck.Type

export const FirstRedResult = Schema.Struct({
  // `green` when every check passed at the tip or only flaked there.
  status: Schema.Literals(["green", "red"]),
  // The earliest Change a broken check first fails at: the Change a correction edits first.
  firstRed: Schema.NullOr(Schema.Struct({
    change: Id,
    commitId: Schema.NonEmptyString,
    checks: Schema.Array(Id),
    findings: Schema.Array(Finding)
  })),
  checks: Schema.Array(FirstRedCheck)
})
export type FirstRedResult = typeof FirstRedResult.Type

const refuse = (message: string) => new CodingError({ code: "invalid_request", message })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
/** A refusal fails typed; any other throw is a bug in this recipe and dies as a defect. */
const policy = <A>(run: () => A) =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(run())
    } catch (error) {
      return error instanceof CodingError ? Effect.fail(error) : Effect.die(error)
    }
  })

const isOpen = (search: CheckSearch) => Open.literals.some((state) => state === search.state)

/** Validates the range and checks and opens one search per check. */
export const beginFirstRed = (input: FirstRedInput): FirstRedCursor => {
  const changes = new Set<string>()
  input.range.forEach((implementation, index) => {
    if (changes.has(implementation.change)) throw refuse(`Change ${implementation.change} appears twice in the range`)
    changes.add(implementation.change)
    const below = input.range[index - 1]
    if (below !== undefined && implementation.parent.commitId !== below.head.commitId) {
      throw refuse(
        `Change ${implementation.change} does not sit on ${below.change}; the range must be one parent chain`
      )
    }
  })
  const checks = new Set<string>()
  for (const check of input.checks) {
    if (checks.has(check.id)) throw refuse(`Check ${check.id} appears twice`)
    checks.add(check.id)
  }
  const tip = input.range.length - 1
  return {
    range: input.range,
    checks: input.checks,
    tries: input.tries ?? 2,
    searches: input.checks.map((check) => ({
      checkId: check.id,
      state: "tip",
      pass: 0,
      fail: tip,
      failures: 0,
      skipped: [],
      passing: null,
      failing: null,
      runs: 0
    }))
  }
}

/** The untested index nearest the middle of the open interval, lower on a tie; undefined when none is left. */
const middle = (search: CheckSearch): number | undefined => {
  const center = (search.pass + search.fail) / 2
  let best: number | undefined
  for (let index = search.pass + 1; index < search.fail; index++) {
    if (search.skipped.includes(index)) continue
    if (best === undefined || Math.abs(index - center) < Math.abs(best - center)) best = index
  }
  return best
}

/** Where an open search runs its check this round. */
export const probeIndex = (cursor: FirstRedCursor, search: CheckSearch): number => {
  switch (search.state) {
    case "tip":
    case "reproduce":
      return cursor.range.length - 1
    case "good":
      return 0
    default: {
      const index = middle(search)
      if (index === undefined) throw new Error(`Check ${search.checkId} has no Change left to probe`)
      return index
    }
  }
}

/** A bisect with no untested Change left between its last pass and first failure has its answer. */
const settle = (search: CheckSearch): CheckSearch =>
  search.state === "bisect" && middle(search) === undefined ? { ...search, state: "broken" } : search

/** Folds one probe's receipt into its search. */
const observe = (cursor: FirstRedCursor, search: CheckSearch, index: number, receipt: Receipt): CheckSearch => {
  const check = cursor.checks.find((candidate) => candidate.id === search.checkId)!
  const implementation = cursor.range[index]!
  if (!receiptMatches(implementation, check, receipt)) {
    throw invalid(`Check ${check.id} returned a receipt for another revision than ${implementation.change}`)
  }
  if (receipt.status === "superseded") throw invalid(`Check ${check.id} returned a superseded receipt`)
  const runs = search.runs + 1
  const infra = receipt.status === "failed" && receipt.fault === "infra"
  const passed = receipt.status === "passed"
  switch (search.state) {
    case "tip":
    case "reproduce": {
      if (passed) {
        return search.state === "tip" ?
          { ...search, state: "passed", passing: receipt, runs } :
          { ...search, state: "flaky", passing: receipt, runs }
      }
      if (infra) {
        // The tip never measured: nothing to blame. A rerun the host could not measure spends no try, but the
        // tip runs at most maximumTries times; then the recorded failure stands.
        if (search.state === "tip") return { ...search, state: "untestable", failing: receipt, runs }
        return { ...search, state: runs >= maximumTries ? "good" : "reproduce", runs }
      }
      const failures = search.failures + 1
      return {
        ...search,
        state: failures >= cursor.tries ? "good" : "reproduce",
        failures,
        failing: receipt,
        runs
      }
    }
    case "good":
      if (passed) return settle({ ...search, state: "bisect", passing: receipt, runs })
      // An unmeasured last green proves no lower bound, so no Change in the range can be blamed.
      if (infra) return { ...search, state: "untestable", passing: null, runs }
      return { ...search, state: "broken-at-good", passing: null, failing: receipt, runs }
    default:
      if (passed) return settle({ ...search, pass: index, passing: receipt, runs })
      if (infra) return settle({ ...search, skipped: [...search.skipped, index], runs })
      return settle({ ...search, fail: index, failing: receipt, runs })
  }
}

/** Folds a round's receipts, keyed by check id, into the next cursor. */
export const advanceFirstRed = (
  cursor: FirstRedCursor,
  receipts: Readonly<Record<string, Receipt>>
): FirstRedCursor => ({
  ...cursor,
  searches: cursor.searches.map((search) => {
    if (!isOpen(search)) return search
    const receipt = receipts[search.checkId]
    if (receipt === undefined) throw invalid(`Check ${search.checkId} returned no receipt`)
    return observe(cursor, search, probeIndex(cursor, search), receipt)
  })
})

export const firstRedDone = (cursor: FirstRedCursor): boolean => !cursor.searches.some(isOpen)

/** The verdicts, and the earliest Change a broken check first fails at. */
export const finishFirstRed = (cursor: FirstRedCursor): FirstRedResult => {
  if (!firstRedDone(cursor)) throw new Error("The search still has open checks")
  const checks = cursor.searches.map((search): FirstRedCheck => {
    const check = cursor.checks.find((candidate) => candidate.id === search.checkId)!
    const broken = search.state === "broken"
    return {
      checkId: search.checkId,
      target: check.target,
      verdict: search.state as Verdict,
      change: broken ? cursor.range[search.fail]!.change : null,
      candidates: broken ?
        search.skipped.filter((index) => index > search.pass && index < search.fail).sort((a, b) => a - b)
          .map((index) => cursor.range[index]!.change) :
        [],
      failing: search.failing,
      passing: search.passing,
      runs: search.runs
    }
  })
  const broken = cursor.searches.filter((search) => search.state === "broken")
  const earliest = Math.min(...broken.map((search) => search.fail))
  const owner = cursor.range[earliest]
  const first = broken.filter((search) => search.fail === earliest)
  return {
    status: checks.every((check) => check.verdict === "passed" || check.verdict === "flaky") ? "green" : "red",
    firstRed: owner === undefined ? null : {
      change: owner.change,
      commitId: owner.head.commitId,
      checks: first.map((search) => search.checkId),
      findings: first.flatMap((search) => search.failing?.findings ?? [])
    },
    checks
  }
}

const Begin = Action.make("coding/first-red-begin", {
  payload: FirstRedInput,
  success: FirstRedCursor,
  error: CodingError
})
const Advance = Action.make("coding/first-red-advance", {
  payload: { cursor: FirstRedCursor, receipts: Schema.Record(Schema.String, Receipt) },
  success: FirstRedCursor,
  error: CodingError
})
const Finish = Action.make("coding/first-red-finish", {
  payload: { cursor: FirstRedCursor },
  success: FirstRedResult,
  error: CodingError
})

/** One probe per open check; finished checks never run again. */
const probes = (cursor: FirstRedCursor) =>
  Object.fromEntries(
    cursor.searches.filter(isOpen).map((search) => {
      const check = cursor.checks.find((candidate) => candidate.id === search.checkId)!
      return [search.checkId, RunCheck.call({ implementation: cursor.range[probeIndex(cursor, search)]!, check })]
    })
  )

type RoundFlow = Flow.Flow<
  "coding/FirstRedRound",
  typeof FirstRedCursor,
  typeof FirstRedResult,
  typeof atomError,
  Action.Requirement<(typeof RunCheck | typeof Advance | typeof Finish)["name"]>
>
/** Tip runs, one last-green run and log2(range) bisect rounds, plus one per skipped Change. */
const Round: RoundFlow = Flow.make("coding/FirstRedRound", {
  payload: FirstRedCursor,
  success: FirstRedResult,
  error: atomError,
  maxRounds: maximumTries + maximumRange + 1,
  body: Node.capture({}, (cursor) =>
    Node.all(probes(cursor)).pipe(
      Node.bindPlanned(Node.capture({}, (receipts) => Advance.call({ cursor, receipts }))),
      Node.branch({
        if: Node.capture({}, (next) => firstRedDone(next)),
        then: Node.capture({}, (next) =>
          Finish.call({ cursor: next }).pipe(Node.bindPlanned(Node.capture({}, (result) => Flow.done(result))))),
        else: Node.capture({}, (next) =>
          Round.to(next))
      })
    ))
})

export const FirstRed = Flow.make("coding/FirstRed", {
  description:
    "Run checks on the newest stack tip; for each one that fails, rerun it there, run it at the last green, and bisect the Changes between to the first one that fails it.",
  payload: FirstRedInput,
  success: FirstRedResult,
  error: atomError,
  body: Node.capture(
    {},
    (input) => Begin.call(input).pipe(Node.bindPlanned(Node.capture({}, (cursor) => Round.child(cursor))))
  )
})

/** Compose with the host's `coding/check` implementation (checks.ts's `checkLayers` or another delegate). */
export const firstRedLayers = Layer.mergeAll(
  Interpreter.layer(FirstRed),
  Interpreter.layer(Round),
  Begin.toLayer((input) => policy(() => beginFirstRed(input))),
  Advance.toLayer(({ cursor, receipts }) => policy(() => advanceFirstRed(cursor, receipts))),
  Finish.toLayer(({ cursor }) => policy(() => finishFirstRed(cursor)))
)
