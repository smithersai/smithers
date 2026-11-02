/**
 * Admitting outside work: jj stacks other authors built on the mythical tip
 * append to it as Changes, each gated by its fast checks.
 *
 * An outside stack is one author's linear run of jj commits, `base..head`,
 * built on the tip. `coding/AppendOutsideStack` takes stacks in order and, for
 * each, rebases it onto the current tip by change id (the author's change ids
 * survive), runs every fast check on the applied head, and admits it when the
 * required fast checks pass. A stack that conflicts, is red, or is already on
 * the stack is refused and rebased back onto its own base, and the next stack
 * applies onto the last admitted head. Finally the target bookmark
 * fast-forwards from the expected tip to the last admitted head. See
 * outside-stack.md.
 */
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { runSourceProcess } from "./immutable-source.ts"
import { NativeCoding } from "./native.ts"
import {
  Change,
  Check,
  CodingError,
  Finding,
  Implementation,
  Receipt,
  receiptMatches,
  receiptOutage,
  Revision,
  ValidatedChange
} from "./schema.ts"
import { RunCheck } from "./workflow.ts"

const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Bookmark = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/))
/** The most commits one outside stack may carry. */
export const maximumAtoms = 256

/** One author's stack: the linear commits `base..head`, whose root's sole parent is `base`. */
export const OutsideStack = Schema.Struct({
  id: Change.fields.id,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  base: CommitId,
  head: CommitId
})
export type OutsideStack = typeof OutsideStack.Type
export const AppendInput = Schema.Struct({
  /** The bookmark that names the mythical tip. */
  target: Bookmark,
  /** The tip the caller saw; a target that moved since is evicted before anything is applied. */
  expected: Schema.optionalKey(CommitId),
  stacks: Schema.Array(OutsideStack).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /** The repository's checks; only fast ones gate admission here. */
  checks: Schema.Array(Check).check(Schema.isMaxLength(64))
})
export type AppendInput = typeof AppendInput.Type
export const RefusalReason = Schema.Literals([
  "empty",
  "not_linear",
  "stale",
  "base_not_on_tip",
  "already_applied",
  "conflict",
  "fast_gate"
])
export const Refusal = Schema.Struct({
  reason: RefusalReason,
  message: Schema.NonEmptyString,
  findings: Schema.Array(Finding)
})
/** A stack the tip does not take; its commits are back on its own base. */
export class StackRefused extends Schema.TaggedError<StackRefused>()("coding/StackRefused", {
  stack: Change.fields.id,
  ...Refusal.fields
}) {}
export const StackOutcome = Schema.Struct({
  stack: Change.fields.id,
  status: Schema.Literals(["admitted", "refused"]),
  /** The tip after this stack: its applied head when admitted, the unchanged tip when refused. */
  head: Revision,
  change: Schema.NullOr(ValidatedChange),
  refusal: Schema.NullOr(Refusal)
})
export type StackOutcome = typeof StackOutcome.Type
export const AppendResult = Schema.Struct({
  target: Bookmark,
  /** The target's commit after admission. */
  tip: CommitId,
  outcomes: Schema.Array(StackOutcome)
})
export type AppendResult = typeof AppendResult.Type

/** The repository operations admission needs. */
export interface OutsideStacksService {
  /** The target's revision; `expected` that differs is `evicted`. */
  readonly tip: (target: string, expected?: string) => Effect.Effect<Revision, CodingError>
  /** Rebase the stack onto `parent` by change id; answers its implementation there, or refuses and restores it. */
  readonly apply: (stack: OutsideStack, parent: Revision) => Effect.Effect<Implementation, CodingError | StackRefused>
  /** Rebase an applied stack back onto its own base. */
  readonly restore: (
    target: string,
    stack: OutsideStack,
    implementation: Implementation
  ) => Effect.Effect<void, CodingError>
  /** Fast-forward the target from `expected` to `head`; a target that moved is `evicted`. */
  /**
   * Fast-forward the target from `expected` to the last of `heads`, the admitted heads in order; a
   * target that moved, or a head rewritten since its checks, is `evicted`.
   */
  readonly advance: (
    target: string,
    expected: string,
    heads: ReadonlyArray<string>
  ) => Effect.Effect<string, CodingError>
  /** Put every stack this run moved above `tip` back on its own base, newest first. */
  readonly sweep: (
    target: string,
    stacks: ReadonlyArray<OutsideStack>,
    tip: string
  ) => Effect.Effect<void, CodingError>
}
export class OutsideStacks extends Context.Service<OutsideStacks, OutsideStacksService>()("coding/OutsideStacks") {}

export interface Options {
  readonly repositoryPath: string
  /** PATH, HOME and the jj settings the operator selected; nothing else reaches jj. */
  readonly environment: Readonly<Record<string, string>>
}

const evicted = (message: string) => new CodingError({ code: "evicted", message })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const bounded = (text: string, limit = 1_024) => {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
const jjMinutes = 2
/** change id, commit id, parent commit ids, and whether jj records a conflict. */
const atomTemplate =
  "change_id ++ \" \" ++ commit_id ++ \" \" ++ parents.map(|p| p.commit_id()).join(\",\") ++ \" \" ++ if(conflict, \"conflict\", \"clean\") ++ \"\\n\""
interface Atom {
  readonly changeId: string
  readonly commitId: string
  readonly parents: ReadonlyArray<string>
  readonly conflict: boolean
}
const parseAtoms = (text: string): Array<Atom> =>
  lines(text).map((line) => {
    const [changeId = "", commitId = "", parents = "", state = ""] = line.split(" ")
    return { changeId, commitId, parents: parents.split(",").filter((id) => id !== ""), conflict: state === "conflict" }
  })

/** The jj implementation over the repository the host serves. */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const native = yield* NativeCoding, spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const root = options.repositoryPath
    const jj = (args: ReadonlyArray<string>) =>
      runSourceProcess(
        { repositoryPath: root, fs, environment: options.environment },
        ["jj", "--no-pager", "--color=never", ...args],
        root,
        jjMinutes * 60_000
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) =>
          error instanceof CodingError
            ? error
            : unavailable(`jj could not run on this host: ${bounded(String(error), 500)}`)
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0 && !result.stdout.truncated
            ? Effect.succeed(result.stdout.text)
            : Effect.fail(unavailable(`jj ${args[0]} refused: ${bounded(result.stderr.text)}`))
        )
      )
    const log = (revset: string, template: string) => jj(["log", "--no-graph", "-r", revset, "-T", template])
    const commitOf = (revset: string, what: string) =>
      log(revset, "commit_id ++ \"\\n\"").pipe(
        Effect.flatMap((text) => {
          const found = lines(text)
          return found.length === 1
            ? Effect.succeed(found[0]!)
            : Effect.fail(invalid(`${what} must resolve to one commit`))
        })
      )
    const changeRevset = (changeIds: ReadonlyArray<string>) => changeIds.map((id) => `change_id(${id})`).join(" | ")
    /** The visible commits that now carry these change ids, in order; undefined when one is divergent or gone. */
    const current = (changeIds: ReadonlyArray<string>) =>
      log(changeRevset(changeIds), atomTemplate).pipe(
        Effect.map((text) => {
          const found = parseAtoms(text)
          const atoms = changeIds.map((id) => found.filter((atom) => atom.changeId === id))
          return atoms.every((matches) => matches.length === 1) ? atoms.map((matches) => matches[0]!) : undefined
        })
      )
    const revisions = (changeIds: ReadonlyArray<string>) =>
      native.read(changeIds).pipe(
        Effect.mapError((error) => unavailable(`The stack could not be read: ${error.message}`)),
        Effect.flatMap((read) => {
          const found = changeIds.map((id) => read.revisions.find((entry) => entry.changeId === id))
          return found.every((entry) => entry !== undefined && entry.kind === "resolved")
            ? Effect.succeed(found.map((entry) => ({
              changeId: entry.changeId,
              commitId: entry.commitId,
              treeId: entry.treeId,
              operationId: read.operationId,
              parentCommitIds: [...entry.parentCommitIds]
            })))
            : Effect.fail(invalid("The stack's commits are not resolved revisions"))
        })
      )
    const refuse = (stack: OutsideStack, reason: typeof RefusalReason.Type, message: string) =>
      new StackRefused({ stack: stack.id, reason, message, findings: [] })
    /** The author's commits as they were enqueued, oldest first, by change id. */
    const chain = (stack: OutsideStack) =>
      Effect.gen(function*() {
        const known = lines(yield* log(`present(${stack.base}) | present(${stack.head})`, "commit_id ++ \"\\n\""))
        if (known.length !== new Set([stack.base, stack.head]).size) {
          return yield* refuse(stack, "stale", `${stack.id}: its base or head no longer exists in this repository`)
        }
        // Bounded: an unrelated head must not read the whole history.
        const atoms = parseAtoms(
          yield* jj([
            "log",
            "--no-graph",
            "-n",
            String(maximumAtoms + 1),
            "-r",
            `${stack.base}..${stack.head}`,
            "-T",
            atomTemplate
          ])
        ).toReversed()
        if (atoms.length === 0) {
          return yield* refuse(stack, "empty", `${stack.id}: ${stack.head} adds nothing to ${stack.base}`)
        }
        if (atoms.length > maximumAtoms) {
          return yield* refuse(stack, "not_linear", `${stack.id}: more than ${maximumAtoms} commits`)
        }
        const linear = atoms.every((atom, index) =>
          atom.parents.length === 1 && atom.parents[0] === (index === 0 ? stack.base : atoms[index - 1]!.commitId)
        ) && atoms.at(-1)!.commitId === stack.head
        if (!linear) {
          return yield* refuse(
            stack,
            "not_linear",
            `${stack.id}: ${stack.base}..${stack.head} is not one line of commits on its base`
          )
        }
        return atoms
      })
    const rebase = (changeId: string, destination: string) =>
      jj(["rebase", "-s", `change_id(${changeId})`, "-d", destination]).pipe(Effect.asVoid)
    /**
     * Where a stack goes back to: the visible commit of its base's change.
     * The enqueued base commit may be hidden (an amend in place, or our own
     * rebase of the stack it was built on); rebasing onto it would make it
     * visible again beside its rewrite.
     */
    const baseOf = (stack: OutsideStack) =>
      Effect.gen(function*() {
        const change = lines(yield* log(stack.base, "change_id ++ \"\\n\""))[0]!
        const [atom] = (yield* current([change])) ?? []
        return atom?.commitId
      })
    const tip = (target: string, expected?: string) =>
      Effect.gen(function*() {
        const commit = yield* commitOf(target, `The ${target} bookmark`)
        if (expected !== undefined && commit !== expected) {
          return yield* evicted(`${target} moved from ${expected} to ${commit} before admission`)
        }
        const change = lines(yield* log(commit, "change_id ++ \"\\n\""))[0]!
        const [revision] = yield* revisions([change])
        // A divergent change id could name another commit than the bookmark's.
        return revision!.commitId === commit
          ? revision!
          : yield* invalid(`${target} is ${commit}, but its change reads as ${revision!.commitId}`)
      })
    /** Whether `commit` is still the one visible commit of its change. */
    const visible = (commit: string) =>
      Effect.gen(function*() {
        const change = lines(yield* log(commit, "change_id ++ \"\\n\""))[0]!
        const [atom] = (yield* current([change])) ?? []
        return atom?.commitId === commit
      })
    const apply = (stack: OutsideStack, parent: Revision) =>
      Effect.gen(function*() {
        // A parent rewritten since it was admitted is gone from the tip's line;
        // rebasing onto it would make the hidden commit visible again.
        if (!(yield* visible(parent.commitId))) {
          return yield* evicted(`${parent.commitId} was rewritten during admission; the tip's line is gone`)
        }
        const enqueued = yield* chain(stack)
        const changeIds = enqueued.map((atom) => atom.changeId)
        // The base's change, not its commit: an amend in place below keeps the base on the tip's line.
        const base = yield* baseOf(stack)
        if (base === undefined) {
          return yield* refuse(stack, "stale", `${stack.id}: its base's change is divergent or gone`)
        }
        if (lines(yield* log(`${base} & ::${parent.commitId}`, "commit_id ++ \"\\n\"")).length === 0) {
          return yield* refuse(
            stack,
            "base_not_on_tip",
            `${stack.id}: its base ${stack.base} is not on the tip; it was built on work the tip does not carry`
          )
        }
        const found = yield* current(changeIds)
        if (found === undefined) {
          return yield* refuse(
            stack,
            "stale",
            `${stack.id}: a change was abandoned or made divergent after it was enqueued`
          )
        }
        let atoms = found
        // A stack the tip already carries is not applied again, and never moved off the tip.
        const carried = lines(yield* log(`(${changeRevset(changeIds)}) & ::${parent.commitId}`, "change_id ++ \"\\n\""))
        if (carried.length > 0) {
          return yield* refuse(
            stack,
            "already_applied",
            `${stack.id}: ${carried.length} of its changes are already on the tip`
          )
        }
        const shaped = atoms.every((atom, index) =>
          index === 0 || (atom.parents.length === 1 && atom.parents[0] === atoms[index - 1]!.commitId)
        )
        if (!shaped) {
          return yield* refuse(stack, "stale", `${stack.id}: its commits no longer form one line; enqueue the new head`)
        }
        // Only a stack already on the parent can carry our own conflicted rebase.
        const onParent = atoms[0]!.parents.length === 1 && atoms[0]!.parents[0] === parent.commitId
        // The author may have rewritten the stack since it was enqueued: only
        // the enqueued content is admitted. A rebase (ours on a replay, or the
        // author's) changes no atom's own diff; a conflicted atom is ours and
        // is restored below.
        const rewritten: Array<string> = []
        for (const [index, atom] of atoms.entries()) {
          if (atom.commitId === enqueued[index]!.commitId || (atom.conflict && onParent)) continue
          const diff = yield* jj([
            "interdiff",
            "--name-only",
            "--from",
            enqueued[index]!.commitId,
            "--to",
            atom.commitId
          ])
          if (lines(diff).length > 0) rewritten.push(atom.changeId)
        }
        if (rewritten.length > 0) {
          return yield* refuse(
            stack,
            "stale",
            `${stack.id}: ${rewritten.length} of its changes were rewritten after it was enqueued; enqueue the new head`
          )
        }
        // A replay after a crash finds the stack already on the parent.
        if (atoms[0]!.parents.length !== 1 || atoms[0]!.parents[0] !== parent.commitId) {
          yield* rebase(changeIds[0]!, parent.commitId)
          const rebased = yield* current(changeIds)
          if (rebased === undefined) return yield* invalid(`${stack.id} could not be read after rebasing`)
          atoms = rebased
        }
        const conflicted = atoms.filter((atom) => atom.conflict)
        if (conflicted.length > 0) {
          const paths = yield* jj(["resolve", "--list", "-r", conflicted[0]!.commitId]).pipe(
            Effect.map((text) => lines(text).map((line) => line.split(/\s{2,}|\t/, 1)[0]!)),
            Effect.orElseSucceed(() => [] as Array<string>)
          )
          yield* rebase(changeIds[0]!, base)
          return yield* refuse(
            stack,
            "conflict",
            `${stack.id} conflicts with the tip: ${bounded(paths.join(", ") || conflicted[0]!.changeId)}`
          )
        }
        const applied = yield* revisions(changeIds)
        const head = applied.at(-1)!
        const linear = applied.every((atom, index) =>
          atom.commitId === atoms[index]!.commitId && atom.parentCommitIds.length === 1 &&
          atom.parentCommitIds[0] === (index === 0 ? parent.commitId : applied[index - 1]!.commitId)
        )
        if (!linear) {
          yield* rebase(changeIds[0]!, base)
          return yield* invalid(`${stack.id} is not one line on the tip after rebasing`)
        }
        const writes = lines(yield* jj(["diff", "--name-only", "--from", parent.commitId, "--to", head.commitId]))
        return { change: stack.id, parent, atoms: applied, head, reads: [], writes }
      })
    /**
     * Moving a stack back must never move the target: if it now points at the
     * stack or above it (someone landed it, or set the tip onto it), the stack
     * stays where it is and the move is `evicted`. An author's own bookmarks
     * on the stack move back with it.
     */
    const unpinned = (target: string, stack: OutsideStack, rootChange: string) =>
      Effect.gen(function*() {
        const pinned = lines(
          yield* log(
            `bookmarks(exact:${JSON.stringify(target)}) & change_id(${rootChange})::`,
            "local_bookmarks.map(|b| b.name()).join(\",\") ++ \"\\n\""
          )
        )
        if (pinned.length > 0) {
          return yield* evicted(`${stack.id} is under ${target}; it is not moved back`)
        }
      })
    const restore = (target: string, stack: OutsideStack, implementation: Implementation) =>
      Effect.gen(function*() {
        const first = implementation.atoms[0]!.changeId
        const [atom] = (yield* current([first])) ?? []
        if (atom === undefined) return yield* invalid(`${stack.id}: its first change is divergent or gone`)
        const base = yield* baseOf(stack)
        if (base === undefined) return yield* invalid(`${stack.id}: its base's change is divergent or gone`)
        if (atom.parents.length === 1 && atom.parents[0] === base) return
        yield* unpinned(target, stack, first)
        yield* rebase(first, base)
      })
    const advance = (target: string, expected: string, heads: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const head = heads.at(-1) ?? expected
        const now = yield* commitOf(target, `The ${target} bookmark`)
        if (now === head) return head
        if (now !== expected) return yield* evicted(`${target} moved from ${expected} to ${now} during admission`)
        if (head === expected) return head
        // A head rewritten since it was gated is not what the checks measured;
        // setting the bookmark over it would make the hidden commit visible again.
        for (const admitted of heads) {
          if (!(yield* visible(admitted))) {
            return yield* evicted(`${admitted} was rewritten during admission; its checks measured another commit`)
          }
        }
        // Without --allow-backwards jj refuses a move that is not a fast-forward.
        yield* jj(["bookmark", "set", target, "-r", head])
        const landed = yield* commitOf(target, `The ${target} bookmark`)
        return landed === head ? landed : yield* invalid(`${target} is ${landed}, not ${head}`)
      })
    const sweep = (target: string, stacks: ReadonlyArray<OutsideStack>, start: string) =>
      Effect.gen(function*() {
        // The starting tip may have been amended in place during the run; its change still names it.
        const startChange = lines(yield* log(start, "change_id ++ \"\\n\""))[0]!
        const [now] = (yield* current([startChange])) ?? []
        const tip = now?.commitId ?? start
        yield* Effect.forEach(
          stacks.toReversed(),
          (stack) =>
            Effect.gen(function*() {
              const enqueued = yield* chain(stack).pipe(
                Effect.catchTag("coding/StackRefused", () => Effect.succeed([]))
              )
              const [root] = enqueued
              if (root === undefined) return
              const [atom] = (yield* current([root.changeId])) ?? []
              // Only a stack this run moved: one now above the tip it started from.
              if (
                atom === undefined ||
                lines(yield* log(`${atom.commitId} & (${tip}:: ~ ${tip})`, "commit_id")).length === 0
              ) {
                return
              }
              const base = yield* baseOf(stack)
              if (base === undefined || (atom.parents.length === 1 && atom.parents[0] === base)) return
              yield* unpinned(target, stack, root.changeId)
              yield* rebase(root.changeId, base)
            }),
          { discard: true }
        )
      })
    const service: OutsideStacksService = { tip, apply, restore, advance, sweep }
    return service
  })
export const layer = (options: Options) => Layer.effect(OutsideStacks)(make(options))

// A replayed write reconciles first (apply finds the stack on its parent,
// restore finds it on its base, advance finds the target at the head), so a
// restarted run may dispatch them again; `once` keeps failures as verdicts.
const once = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
export const ReadTip = Action.make("coding/read-outside-stack-tip", {
  tier: "sealed",
  idempotencyKey: undefined,
  payload: {
    target: Bookmark,
    expected: Schema.optionalKey(CommitId),
    stacks: Schema.Array(Change.fields.id),
    checks: Schema.Array(Check)
  },
  success: Revision,
  error: CodingError,
  nondeterministic: true
})
export const ApplyStack = Action.make("coding/apply-outside-stack", {
  tier: "irreversible",
  idempotencyKey: ({ stack, parent }) => `${stack.id}/${stack.head}/${parent.commitId}`,
  retryPolicy: once,
  payload: { stack: OutsideStack, parent: Revision },
  success: Implementation,
  error: Schema.Union([StackRefused, CodingError]),
  nondeterministic: true
})
export const GateStack = Action.make("coding/gate-outside-stack", {
  tier: "irreversible",
  idempotencyKey: ({ stack, implementation }) => `${stack.id}/${implementation.head.commitId}`,
  retryPolicy: once,
  payload: {
    stack: OutsideStack,
    target: Bookmark,
    earlier: Schema.Array(Change.fields.id),
    checks: Schema.Array(Check),
    implementation: Implementation,
    receipts: Schema.Record(Schema.String, Receipt)
  },
  success: StackOutcome,
  error: Schema.Union([StackRefused, CodingError]),
  nondeterministic: true
})
export const AdvanceTip = Action.make("coding/advance-outside-stack-tip", {
  tier: "irreversible",
  idempotencyKey: ({ target, expected, outcomes }) =>
    `${target}/${expected}/${outcomes.at(-1)?.head.commitId ?? expected}`,
  retryPolicy: once,
  payload: {
    target: Bookmark,
    expected: CommitId,
    stacks: Schema.Array(OutsideStack),
    outcomes: Schema.Array(StackOutcome)
  },
  success: AppendResult,
  error: CodingError,
  nondeterministic: true
})

export const AppendError = Schema.Union([CodingError, StackRefused, RunCheck.errorSchema])
/** The run failed: every stack it moved goes back on its own base, then the run fails with that failure. */
export const SweepStacks = Action.make("coding/sweep-outside-stacks", {
  tier: "irreversible",
  idempotencyKey: ({ tip, stacks }) => `${tip}/sweep/${stacks.map((stack) => `${stack.id}:${stack.head}`).join(",")}`,
  retryPolicy: once,
  payload: { target: Bookmark, stacks: Schema.Array(OutsideStack), tip: CommitId, failure: AppendError },
  success: Schema.Never,
  error: AppendError,
  nondeterministic: true
})

/** The fast checks' verdict on an applied stack: admitted, refused (and restored), or an outage. */
export const gate = (
  stack: OutsideStack,
  /** Stacks earlier in the queue: a finding may blame one of them, as FastGate allows an earlier Change. */
  earlier: ReadonlyArray<string>,
  checks: ReadonlyArray<Check>,
  implementation: Implementation,
  receipts: Readonly<Record<string, Receipt>>
): StackOutcome | StackRefused | CodingError => {
  const fast = checks.filter((check) => check.tier === "fast")
  for (const check of fast) {
    const receipt = receipts[check.id]
    if (!receipt || !receiptMatches(implementation, check, receipt)) {
      return invalid(`${stack.id}: fast receipt ${check.id} does not identify the applied head`)
    }
  }
  for (const check of fast) {
    for (const finding of receipts[check.id]!.findings) {
      if (
        (finding.owner !== stack.id && !earlier.includes(finding.owner)) ||
        finding.sourceCommitId !== implementation.head.commitId
      ) {
        return invalid(`${stack.id}: ${check.id} supplied a finding with another owner or source revision`)
      }
    }
  }
  for (const check of fast) {
    const outage = receiptOutage(receipts[check.id]!)
    if (outage) return outage
  }
  const red = fast.filter((check) => check.required && receipts[check.id]!.status !== "passed")
  if (red.length > 0) {
    const findings = red.flatMap((check) => {
      const receipt = receipts[check.id]!
      return receipt.findings.length > 0 ? receipt.findings : [{
        owner: stack.id,
        sourceCommitId: implementation.head.commitId,
        message: `${check.id}: ${receipt.status}`
      }]
    })
    return new StackRefused({
      stack: stack.id,
      reason: "fast_gate",
      message: `${stack.id}: ${red.map((check) => check.target).join(", ")} did not pass on the tip`,
      findings
    })
  }
  return {
    stack: stack.id,
    status: "admitted",
    head: implementation.head,
    change: { implementation, receipts: fast.map((check) => receipts[check.id]!) },
    refusal: null
  }
}

const actionLayers = Layer.mergeAll(
  ReadTip.toLayer(({ target, expected, stacks, checks }) =>
    // One receipt per check id, and one outcome per stack id.
    new Set(checks.map((check) => check.id)).size !== checks.length
      ? Effect.fail(new CodingError({ code: "invalid_request", message: "Two checks share one id" }))
      : new Set(stacks).size !== stacks.length
      ? Effect.fail(new CodingError({ code: "invalid_request", message: "Two stacks share one id" }))
      : Effect.flatMap(OutsideStacks, (service) => service.tip(target, expected))
  ),
  ApplyStack.toLayer(({ stack, parent }) => Effect.flatMap(OutsideStacks, (stacks) => stacks.apply(stack, parent))),
  SweepStacks.toLayer(({ target, stacks, tip, failure }) =>
    Effect.flatMap(OutsideStacks, (service) => service.sweep(target, stacks, tip)).pipe(
      Effect.andThen(Effect.fail(failure))
    )
  ),
  GateStack.toLayer(({ target, stack, earlier, checks, implementation, receipts }) =>
    Effect.gen(function*() {
      const verdict = gate(stack, earlier, checks, implementation, receipts)
      // Anything not admitted goes back to its own base before the verdict is recorded.
      if (verdict instanceof StackRefused || verdict instanceof CodingError) {
        yield* Effect.flatMap(OutsideStacks, (stacks) => stacks.restore(target, stack, implementation))
        return yield* verdict
      }
      return verdict
    })
  ),
  AdvanceTip.toLayer(({ target, expected, stacks, outcomes }) =>
    Effect.gen(function*() {
      const service = yield* OutsideStacks
      const heads = outcomes.flatMap((outcome) => outcome.change === null ? [] : [outcome.head.commitId])
      const tip = yield* service.advance(target, expected, heads).pipe(
        // The tip moved, or a head was rewritten, under the run: every stack it
        // moved goes back to its own base, so no admitted work is left off the tip's line.
        // A sweep never moves a stack a bookmark now sits on (a landed advance), so it is safe after any failure;
        // the failure to advance is what the run reports.
        Effect.tapError(() => service.sweep(target, stacks, expected).pipe(Effect.ignore))
      )
      return { target, tip, outcomes }
    })
  )
)

type Stages = Node.Node<
  ReadonlyArray<StackOutcome>,
  typeof ApplyStack.errorSchema.Type | typeof RunCheck.errorSchema.Type,
  Action.Requirement<(typeof ApplyStack | typeof RunCheck | typeof GateStack)["name"]>
>
/** Width is known from the input. A refused stack leaves the tip where it was for the next one. */
const stages = (input: AppendInput, index: number, parent: Planned.Planned<Revision>): Stages => {
  const stack = input.stacks[index]
  if (stack === undefined) return Node.succeed([])
  const fast = input.checks.filter((check) => check.tier === "fast")
  const admitted = ApplyStack.call({ stack, parent }).pipe(
    Node.bindPlanned(
      Node.capture(
        {},
        (implementation) =>
          Node.all(Object.fromEntries(fast.map((check) => [check.id, RunCheck.call({ implementation, check })]))).pipe(
            Node.bindPlanned(
              Node.capture({}, (receipts) =>
                GateStack.call({
                  target: input.target,
                  stack,
                  earlier: input.stacks.slice(0, index).map((entry) => entry.id),
                  checks: fast,
                  implementation,
                  receipts
                }))
            )
          )
      )
    )
  )
  const outcome = admitted.pipe(Node.catch({
    error: StackRefused,
    onFailure: Node.capture({}, (refused) =>
      Node.succeed({
        stack: stack.id,
        status: "refused" as const,
        head: parent,
        change: null,
        refusal: { reason: refused.reason, message: refused.message, findings: refused.findings }
      }))
  }))
  return outcome.pipe(
    Node.bindPlanned(
      Node.capture(
        {},
        (current) =>
          Node.all({ current: Node.succeed(current), next: stages(input, index + 1, current.head) }).pipe(
            Node.map(Node.capture({}, ({ current, next }) => [current, ...next]))
          )
      )
    )
  )
}

export const AppendOutsideStack = Flow.make("coding/AppendOutsideStack", {
  description:
    "Append outside jj stacks to the mythical tip as Changes: rebase each by change id, admit it when its fast checks pass, and fast-forward the tip.",
  capabilities: ["*"],
  modelInvocable: false,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: AppendInput,
  success: AppendResult,
  // A schema-filtered catch keeps its type (Node.catch); every StackRefused becomes a refused outcome.
  error: AppendError,
  body: Node.capture(
    { version: "outside-stack/v1" },
    (input) =>
      ReadTip.call({
        target: input.target,
        stacks: input.stacks.map((stack) => stack.id),
        checks: input.checks,
        ...(input.expected === undefined ? {} : { expected: input.expected })
      })
        .pipe(
          Node.bindPlanned(Node.capture({}, (tip) =>
            stages(input, 0, tip).pipe(
              // Any failure inside: every stack the run moved goes back on its own base first.
              Node.catch({
                onFailure: Node.capture(
                  {},
                  (failure) =>
                    SweepStacks.call({ target: input.target, stacks: input.stacks, tip: tip.commitId, failure })
                )
              }),
              Node.bindPlanned(
                Node.capture(
                  {},
                  (outcomes) =>
                    AdvanceTip.call({ target: input.target, expected: tip.commitId, stacks: input.stacks, outcomes })
                )
              )
            )))
        )
  )
})

/** The flow and its actions; the host supplies `OutsideStacks` (`layer`) and the `coding/check` delegate. */
export const outsideStackLayers = Layer.merge(Interpreter.layer(AppendOutsideStack), actionLayers)
