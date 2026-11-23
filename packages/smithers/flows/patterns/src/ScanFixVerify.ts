/**
 * Scan for issues, fix them in parallel, verify, and repeat until clean.
 *
 * This is the shape of every lint-fix, test-repair, and audit-remediation
 * workflow: the number of issues is a runtime fact, and so is the number of
 * rounds. {@link ReviewLoop} cannot express it, because a review loop revises
 * one artifact; here each issue gets its own fix.
 *
 * The retry bound and fan-out bound are declared, so the plan shows the worst
 * case, including a confirming scan after the last allowed fix round. The
 * engine fixes only issues the scanner returned.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import * as Failure from "./internal/Failure.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `maxIssues` is the declared fan-out bound: a plan cannot know how many
 * issues a scan will find, so the declaration carries the largest fan-out the
 * author will admit. `concurrency` batches those calls exactly as
 * `MapReduce.make` does, so the declared topology never fans out wider than
 * the bound.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly scan: Member<R>
  readonly fix: Member<R>
  readonly verify: Member<R>
  readonly maxRetries: number
  readonly maxIssues: number
  readonly concurrency: number
}

/**
 * Reads the signals a verifier uses to report that nothing is left to fix.
 *
 * A verifier answers with `true` or an object carrying its own `resolved: true`.
 * A symbolic plan-time value is neither, which keeps the declared unrolling
 * conservative.
 *
 * The flow records every verification and stops on an empty scan. Callers
 * read the recorded verdicts with this function.
 *
 * @category predicates
 * @since 0.1.0
 */
export const resolved = (value: unknown): boolean =>
  value === true ||
  Compose.ownTrue(value, "resolved")

/**
 * The declared form of a scan-fix-verify loop.
 *
 * @category models
 * @since 1.0.0
 */
export type ScanFixVerifyFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

// The scan is validated once before any length or indexed reads.
interface Scanned {
  readonly issues: ReadonlyArray<unknown>
  readonly invalid: boolean
}

const scanned = (issues: unknown): Scanned =>
  Array.isArray(issues) ? { issues, invalid: false } : { issues: [], invalid: true }

const invalidScan = (iteration: number): PatternError =>
  new PatternError({
    code: "invalid_input",
    message: `ScanFixVerify scan at iteration ${iteration} must return an array`
  })

const issueCount = (issues: ReadonlyArray<unknown>): number => issues.length

const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const validate = (options: {
  readonly maxRetries: number
  readonly maxIssues?: number | undefined
  readonly concurrency: number
}): PatternError | undefined =>
  positive(options.maxRetries) && positive(options.concurrency) &&
    (options.maxIssues === undefined || positive(options.maxIssues))
    ? undefined
    : new PatternError({
      code: "invalid_decorator",
      message: "ScanFixVerify maxRetries, maxIssues, and concurrency must be positive safe integers"
    })

/**
 * Declares the bounded scan-fix-verify topology and its runtime decisions.
 *
 * Every retry is unrolled, and every retry declares `maxIssues` fix slots in
 * `concurrency`-sized batches, so the plan shows the worst case. Each scan is
 * the subject of a `Node.branch`: an empty scan settles `resolved: true`.
 * Each fix slot is its own `Node.branch` on whether the scan
 * returned an issue at that index, so a run pays for exactly the fixes the
 * scan asked for, and `verify` is handed the fixes of the issues that exist.
 * Issues past `maxIssues` wait for the next round's rescan. After the last
 * allowed fix round, one confirming scan settles the report without more fixes
 * or verification. That scan does not increase `iterations`. Very large retry
 * and issue bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): ScanFixVerifyFlow<R> => {
  const invalid = validate(options)
  if (invalid !== undefined) throw invalid
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { scan: options.scan, fix: options.fix, verify: options.verify }
  const maxRetries = options.maxRetries
  const maxIssues = options.maxIssues
  const concurrency = options.concurrency
  const captures = { maxRetries, maxIssues, concurrency }
  const { name, description } = Compose.label("scanFixVerify", { maxRetries, maxIssues, concurrency }, options, [
    stages.scan,
    stages.fix,
    stages.verify
  ])
  const clean = Node.capture({ ...captures, clean: true }, (issues: ReadonlyArray<unknown>) => issueCount(issues) === 0)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (
      iteration: number,
      verifications: ReadonlyArray<Planned.Planned<unknown>>
    ): Node.Node<unknown, unknown, R> =>
      Node.branch(
        Node.map(
          callMember(stages.scan, { input, iteration }),
          Node.capture({ ...captures, iteration, scan: true }, (issues: unknown) => scanned(issues))
        ),
        {
          if: Node.capture({ ...captures, iteration, invalid: true }, (state: Scanned) => state.invalid),
          then: () => Node.fail(invalidScan(iteration)),
          else: (state: Planned.Planned<Scanned>) =>
            Node.branch(Node.succeed(state.issues), {
              if: clean,
              then: () =>
                Node.succeed({
                  iterations: Math.min(iteration, maxRetries),
                  remaining: [],
                  resolved: true,
                  verifications
                }),
              else: (issues) =>
                iteration > maxRetries
                  ? Node.succeed({ iterations: maxRetries, remaining: issues, resolved: false, verifications })
                  : fixAll(iteration, issues, verifications)
            })
        }
      )
    const fixAll = (
      iteration: number,
      issues: Planned.Planned<ReadonlyArray<unknown>>,
      verifications: ReadonlyArray<Planned.Planned<unknown>>
    ): Node.Node<unknown, unknown, R> => {
      const found = issues as unknown as Readonly<Record<number, unknown>>
      const batches: Array<{
        readonly names: ReadonlyArray<string>
        readonly members: Readonly<Record<string, Node.Node<unknown, unknown, R>>>
      }> = []
      for (let offset = 0; offset < maxIssues; offset += concurrency) {
        const members: Record<string, Node.Node<unknown, unknown, R>> = {}
        const names: Array<string> = []
        const last = Math.min(offset + concurrency, maxIssues)
        for (let index = offset; index < last; index++) {
          names.push(`fix-${index}`)
          // A slot the scan left empty runs nothing: the predicate reads the
          // real issue list, so no fix is paid for an issue that is not there.
          members[`fix-${index}`] = Node.branch(Node.succeed(issues), {
            if: Node.capture(
              { ...captures, iteration, index },
              (list: ReadonlyArray<unknown>) => index < issueCount(list)
            ),
            then: () => callMember(stages.fix, { issue: found[index], index, iteration }),
            else: () => Node.succeed(null)
          })
        }
        batches.push({ names, members })
      }
      const verified = (slots: ReadonlyArray<Planned.Planned<unknown>>): Node.Node<unknown, unknown, R> => {
        // The slots past the scan's length hold nothing; verify is handed the
        // fixes of the issues that exist.
        const fixes = Node.map(
          Node.succeed({ issues, slots }),
          Node.capture(
            { ...captures, iteration, fixes: true },
            (state: { readonly issues: ReadonlyArray<unknown>; readonly slots: ReadonlyArray<unknown> }) =>
              state.slots.slice(0, issueCount(state.issues))
          )
        )
        return Node.bindPlanned(
          fixes,
          Node.capture({ ...captures, iteration }, (fixed) =>
            Node.bindPlanned(
              callMember(stages.verify, { input, issues, fixes: fixed, iteration }),
              Node.capture({ ...captures, iteration }, (verification) =>
                visit(iteration + 1, [...verifications, verification]))
            ))
        )
      }
      // Each batch gates the next one, so the plan carries the width bound
      // as dependency edges, and the slot list is assembled from every
      // member's planned reference: a planned result may be read by field
      // and passed into a payload, never spread into a new array.
      const fanOut = (
        batch: number,
        fixed: ReadonlyArray<Planned.Planned<unknown>>
      ): Node.Node<unknown, unknown, R> => {
        const declared = batches[batch]
        if (declared === undefined) return verified(fixed)
        return Node.bindPlanned(
          Node.all(declared.members),
          Node.capture({ ...captures, iteration, batch }, (reference) =>
            Node.andThen(
              Node.succeed(reference),
              fanOut(batch + 1, [
                ...fixed,
                ...declared.names.map((member) =>
                  (reference as Readonly<Record<string, Planned.Planned<unknown>>>)[member]!
                )
              ])
            ))
        )
      }
      return fanOut(0, [])
    }
    return visit(1, [])
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and declared
    // no error schema. `@smthrs/flow` needs a real one, because the engine
    // encodes a typed failure through it, and this pattern fails with whatever
    // the stage it called failed with.
    // The engine encodes a typed failure through this schema: the pattern's
    // own `PatternError`, and whatever a member it called failed with.
    error: Failure.schemaFor([PatternError], [stages.scan, stages.fix, stages.verify]) as typeof Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

/**
 * Operational callbacks and bounds for {@link run}.
 *
 * When provided, `maxIssues` caps how many issues receive fixes per scan.
 * The verifier sees the full scan and the fixes for its first issues.
 *
 * @category models
 * @since 1.0.0
 */
export interface RuntimeOptions<I, Issue, Fix, Verification, E, R, E2 = E, R2 = R, E3 = E, R3 = R> {
  readonly scan: (input: {
    readonly input: I
    readonly iteration: number
  }) => Effect.Effect<ReadonlyArray<Issue>, E, R>
  readonly fix: (input: {
    readonly issue: Issue
    readonly index: number
    readonly iteration: number
  }) => Effect.Effect<Fix, E2, R2>
  readonly verify: (input: {
    readonly input: I
    readonly issues: ReadonlyArray<Issue>
    readonly fixes: ReadonlyArray<Fix>
    readonly iteration: number
  }) => Effect.Effect<Verification, E3, R3>
  readonly maxRetries: number
  readonly maxIssues?: number | undefined
  readonly concurrency: number
}

/**
 * The loop outcome, with all completed verifications in iteration order.
 * An exhausted loop reports the issues from its final scan.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunResult<Issue, Verification> {
  readonly iterations: number
  readonly remaining: ReadonlyArray<Issue>
  readonly resolved: boolean
  readonly verifications: ReadonlyArray<Verification>
}

/**
 * Runs bounded scans, fixing issues concurrently before each verification.
 * A clean scan or a resolved verification ends the loop immediately.
 * If the fix budget runs out, one confirming scan reports the remaining issues.
 *
 * @category combinators
 * @since 1.0.0
 */
export const run = <I, Issue, Fix, Verification, E, R, E2 = E, R2 = R, E3 = E, R3 = R>(
  input: I,
  options: RuntimeOptions<I, Issue, Fix, Verification, E, R, E2, R2, E3, R3>
): Effect.Effect<RunResult<Issue, Verification>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  const invalid = validate(options)
  if (invalid !== undefined) return Effect.fail(invalid)
  const { scan, fix, verify, maxRetries, maxIssues, concurrency } = options
  return Effect.gen(function*() {
    const verifications: Array<Verification> = []
    let iteration = 1
    while (true) {
      const issues = yield* scan({ input, iteration })
      if (!Array.isArray(issues)) return yield* Effect.fail(invalidScan(iteration))
      if (issues.length === 0 || iteration > maxRetries) {
        return { iterations: Math.min(iteration, maxRetries), remaining: issues, resolved: issues.length === 0, verifications }
      }
      const fixes = yield* Effect.forEach(
        issues.slice(0, maxIssues),
        (issue, index) => fix({ issue, index, iteration }),
        { concurrency }
      )
      const verification = yield* verify({ input, issues, fixes, iteration })
      verifications.push(verification)
      if (resolved(verification)) return { iterations: iteration, remaining: [], resolved: true, verifications }
      iteration += 1
    }
  })
}
