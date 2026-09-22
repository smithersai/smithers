/**
 * Intervene on a real workspace: read a file, propose an edit, gate the write
 * behind an approval, and report what happened.
 *
 * The pattern has the two surfaces every `@smthrs/patterns` module has, and
 * this example uses both over the same std flows. `Intervene.make` builds the
 * declaration: the read and apply steps name `Read.flow` and `Edit.flow` from
 * `@smthrs/std` and inherit their capabilities and effect envelopes, and the
 * apply step sits behind `WithApproval`, so a planner can see the gate before
 * anything runs. `Intervene.run` performs the value-dependent part over a real
 * temp directory, through `Read.run` and `Edit.run`, which are the
 * implementations of the very flows the declaration named.
 *
 * `dryRun` is a declaration-time decision, not a runtime flag the write step is
 * trusted to honor: a dry-run plan has no apply call in it at all, so it cannot
 * reach a writing step even if something later goes wrong.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Flow, Node } from "@smthrs/core"
import * as Intervene from "@smthrs/patterns/Intervene"
import * as WithApproval from "@smthrs/patterns/WithApproval"
import * as Edit from "@smthrs/std/Edit"
import * as Read from "@smthrs/std/Read"
import * as StdError from "@smthrs/std/StdError"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"

/** The rewrite an intervention is asked to perform. */
export const Job = Schema.Struct({
  path: Schema.String,
  from: Schema.String,
  to: Schema.String
})

/** The envelope `Intervene` hands its read flow. */
const ReadCall = Schema.Struct({ phase: Schema.String, input: Job })

/** The envelope `Intervene` hands its propose flow. */
const ProposeCall = Schema.Struct({ phase: Schema.String, input: Job, context: Read.Output })

/** The envelope `Intervene` hands its apply flow, and the approval that gates it. */
const ApplyCall = Schema.Struct({ phase: Schema.String, input: Job, proposal: Edit.Input })

/** The envelope `Intervene` hands its report flow. */
const ReportCall = Schema.Struct({
  phase: Schema.String,
  input: Job,
  proposal: Edit.Input,
  applied: Schema.optional(Edit.Output),
  dryRun: Schema.Boolean
})

/** What the intervention reports when it is done. */
export const Report = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Number,
  dryRun: Schema.Boolean
})

/**
 * Reads the target file. The step names the std read flow and declares no body,
 * so it is a signature a host implements, and it declares the read flow's
 * capabilities and hermetic read-only envelope as its own.
 */
export const ReadTarget = Flow.make({
  name: "read-target",
  input: ReadCall,
  output: Read.Output,
  capabilities: Read.capabilities,
  effects: Read.effects,
  flows: [Read.flow]
})

/** Turns the job into the edit the apply step performs. This step writes nothing. */
export const ProposeEdit = Flow.make({
  name: "propose-edit",
  input: ProposeCall,
  output: Edit.Input,
  body: ({ input }) => Node.succeed({ path: input.path, oldString: input.from, newString: input.to })
})

/** Writes the proposed edit, under the std edit flow's compensable envelope. */
export const ApplyEdit = Flow.make({
  name: "apply-edit",
  input: ApplyCall,
  output: Edit.Output,
  capabilities: Edit.capabilities,
  effects: Edit.effects,
  flows: [Edit.flow]
})

/** Summarizes the intervention. */
export const ReportEdit = Flow.make({
  name: "report-edit",
  input: ReportCall,
  output: Report,
  body: ({ applied, dryRun, proposal }) =>
    Node.succeed({
      path: proposal.path,
      replacements: applied === undefined ? 0 : applied.replacements,
      dryRun
    })
})

/**
 * The approval that gates the write. The only value it may return is the
 * literal `"approved"`, so a denial fails the typed schema decode instead of
 * reaching the edit.
 *
 * `WithApproval` calls it with the wrapped step's payload, the reason the
 * decorator was given, and the scope the answer is remembered under, so that
 * struct is the input it declares.
 */
export const ApproveEdit = Flow.make({
  name: "approve-edit",
  input: Schema.Struct({ input: Schema.Unknown, reason: Schema.String, scope: Schema.String }),
  output: WithApproval.Approved
})

// `apply` and `approval` are whole flows rather than any member, because the
// approval decorates the apply step and a decorator re-declares what it wraps.
// A `@smthrs/core` signature IS a `@smthrs/flow` flow plus its metadata, so
// `.flow` is the value the decorator takes; the three plain stages are members
// and the signature itself satisfies that.
const declaration = {
  read: ReadTarget,
  propose: ProposeEdit,
  apply: ApplyEdit.flow,
  report: ReportEdit,
  approval: ApproveEdit.flow,
  reason: "rewrite the greeting"
}

/** The gated intervention: read, propose, approve, apply, report. */
export const plan = Intervene.make({ ...declaration, dryRun: false })

/** The same intervention as a dry run: the plan has no apply call in it. */
export const dryPlan = Intervene.make({ ...declaration, dryRun: true })

/**
 * Everything an intervention can fail with. Naming the union keeps the failure
 * channel readable instead of widening it to `unknown`: `PlatformError` comes
 * from the temp directory and the read-back, `StdError` from `Read.run` and
 * `Edit.run`, and `SchemaError` from an approval that does not decode as
 * `"approved"`.
 */
export type Failure = PlatformError.PlatformError | StdError.StdError | Schema.SchemaError

/**
 * Runs an intervention over a fresh temp directory and returns the report next
 * to the file's contents afterwards, so a caller can see whether the write
 * actually happened.
 */
export const intervene = (options: {
  readonly dryRun: boolean
  readonly decision: string
}): Effect.Effect<
  { readonly report: typeof Report.Type; readonly content: string },
  Failure,
  FileSystem.FileSystem
> =>
  Effect.scoped(Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "flows-intervene-" })
    const path = `${directory}/greeting.txt`
    yield* fileSystem.writeFileString(path, "Hello, world.\n")

    const report = yield* Intervene.run(
      { path, from: "Hello, world.", to: "Hello, Ada." },
      {
        dryRun: options.dryRun,
        // The declaration named `Read.flow` and `Edit.flow`; execution runs
        // their implementations, `Read.run` and `Edit.run`.
        read: ({ input }) => Read.run({ path: input.path }),
        propose: ({ input }) =>
          Effect.succeed({ path: input.path, oldString: input.from, newString: input.to }),
        apply: ({ proposal }) => Edit.run(proposal),
        report: ({ applied, dryRun, proposal }) =>
          Effect.succeed({
            path: proposal.path,
            replacements: applied === undefined ? 0 : applied.replacements,
            dryRun
          }),
        approval: () => Effect.succeed(options.decision)
      }
    )
    const content = yield* fileSystem.readFileString(path)
    return { report, content }
  }))

/**
 * Applies the rewrite with an approval that answers `"approved"`, on a real
 * Node filesystem.
 */
export const main: Effect.Effect<
  { readonly report: typeof Report.Type; readonly content: string },
  Failure
> = intervene({ dryRun: false, decision: "approved" }).pipe(
  Effect.provide(NodeFileSystem.layer)
)
