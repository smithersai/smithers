/**
 * Find outdated dependencies, update the safe ones in parallel, verify, and report.
 *
 * Port of the 0.x `dependency-update.jsx`. A scanner agent lists the outdated
 * packages and rates each update: major, minor or patch, breaking or not.
 * Every update that is neither major nor breaking goes to an updater agent,
 * three at a time, and a failing updater drops only its own result. When at
 * least one update reported back, a verify step runs the typecheck, test and
 * build commands. A report counts the outcomes and holds major and breaking
 * updates back for manual review.
 *
 * 0.x re-rendered its tree once the scan landed; here the updates run in a `.child()` flow whose body plans over the real scan.
 * 0.x verified with an agent told to run the suite; here verification is a deterministic `Action` a host implements, because the 1.0 completion brake refuses an agent's report of commands its run never recorded.
 * `ScanFixVerify` does not fit: it rescans until clean and fixes every issue the scan returns, where 0.x scanned once and held major and breaking updates back.
 * 0.x gave the agents `bash`, `read` and `edit` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One outdated package, as the scanner rates it. */
export const Dependency = Schema.Struct({
  name: Schema.String,
  current: Schema.String,
  latest: Schema.String,
  type: Schema.Literals(["major", "minor", "patch"]),
  breaking: Schema.Boolean,
  changelog: Schema.optional(Schema.String)
})

/** The scanner's answer. */
export const Scan = Schema.Struct({
  outdated: Schema.Array(Dependency),
  totalOutdated: Schema.Number
})

/** What one updater did. */
export const UpdateResult = Schema.Struct({
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
  status: Schema.Literals(["updated", "skipped", "failed"]),
  notes: Schema.String
})

/** The verification suite's outcome. */
export const Verification = Schema.Struct({
  passed: Schema.Boolean,
  typecheck: Schema.Boolean,
  tests: Schema.Boolean,
  build: Schema.Boolean,
  errors: Schema.Array(Schema.String)
})

/** The report the flow settles with. */
export const Report = Schema.Struct({
  updated: Schema.Number,
  skipped: Schema.Number,
  failed: Schema.Number,
  breaking: Schema.Number,
  verified: Schema.Boolean,
  summary: Schema.String
})

type Dependency = typeof Dependency.Type
type UpdateResult = typeof UpdateResult.Type

/** Lists outdated packages and rates each update. */
export const ScanDependencies = AgentAction.make("examples/DependencyUpdate/Scan", {
  payload: { directory: Schema.String, checkCmd: Schema.String, lockfile: Schema.String },
  output: Scan,
  seat,
  system: [
    `You are a dependency analyst. Check for outdated packages and assess
each update's risk level (major/minor/patch, breaking changes).`
  ],
  prompt: ({ checkCmd, directory, lockfile }) =>
    `Check for outdated dependencies:\nDirectory: ${directory}\nCommand: ${checkCmd}\nAlso check: ${lockfile}`
})

/** Updates one package. */
export const UpdateDependency = AgentAction.make("examples/DependencyUpdate/Update", {
  payload: {
    name: Schema.String,
    current: Schema.String,
    latest: Schema.String,
    type: Dependency.fields.type,
    directory: Schema.String,
    changelog: Schema.optional(Schema.String)
  },
  output: UpdateResult,
  seat,
  system: [
    `You are a dependency updater. Update the specified package.
For major updates, check the changelog for breaking changes and apply necessary code fixes.`
  ],
  prompt: ({ changelog, current, directory, latest, name, type }) =>
    `Update ${name}: ${current} -> ${latest} (${type})\nDirectory: ${directory}\n${
      changelog === undefined ? "" : `Changelog: ${changelog}`
    }`
})

/**
 * Runs the typecheck, test and build commands in the directory and reports
 * which passed. A host implements it with its shell; the tests implement it
 * with a deterministic layer.
 */
export const Verify = Action.make("examples/DependencyUpdate/Verify", {
  payload: { directory: Schema.String, typecheckCmd: Schema.String, testCmd: Schema.String, buildCmd: Schema.String },
  success: Verification
})

/** 0.x updated only patch and minor updates that are not breaking. */
const autoUpdatable = (dependency: Dependency) => !dependency.breaking && dependency.type !== "major"

/**
 * Updates the safe candidates. It runs as a child execution, so its payload
 * is real when its body plans: the filter and the fan-out below read the scan
 * directly instead of branching on a planned value.
 */
export const UpdateCandidates = Flow.make("examples/DependencyUpdate/UpdateCandidates", {
  payload: { directory: Schema.String, outdated: Schema.Array(Dependency) },
  success: Schema.Array(UpdateResult),
  body: ({ directory, outdated }) => {
    const candidates = outdated.filter(autoUpdatable)
    if (candidates.length === 0) return Node.succeed([])
    // 0.x `continueOnFail`: a failed updater settles as null instead of failing its siblings.
    const members = Object.fromEntries(candidates.map(({ breaking: _, ...dependency }) => [
      dependency.name,
      Node.catch(UpdateDependency.call({ ...dependency, directory }), { onFailure: () => Node.succeed(null) })
    ]))
    const joined = Bounded.all(members, { concurrency: 3 })
    return Node.map(joined, (updated) => Object.values(updated).filter(Schema.is(UpdateResult)))
  }
})

/** Counts the outcomes. Pure, so it is a `Node.map`, not a step. */
const report = ({ scan, updates, verify }: {
  readonly scan: typeof Scan.Type
  readonly updates: ReadonlyArray<UpdateResult>
  readonly verify: typeof Verification.Type | null
}): typeof Report.Type => {
  const count = (status: UpdateResult["status"]) => updates.filter((u) => u.status === status).length
  const heldBack = scan.outdated.filter((d) => !autoUpdatable(d)).length
  const breaking = scan.outdated.filter((d) => d.breaking).length
  return {
    updated: count("updated"),
    skipped: count("skipped") + heldBack,
    failed: count("failed"),
    breaking,
    verified: verify?.passed ?? false,
    summary: `Updated ${count("updated")}/${scan.totalOutdated} deps. ${breaking} major updates need manual review.`
  }
}

/** The flow: scan, update the safe candidates, verify when anything reported back, report. */
export const DependencyUpdate = Flow.make("examples/DependencyUpdate", {
  payload: {
    directory: Schema.String,
    checkCmd: Schema.optional(Schema.String),
    lockfile: Schema.optional(Schema.String),
    typecheckCmd: Schema.optional(Schema.String),
    testCmd: Schema.optional(Schema.String),
    buildCmd: Schema.optional(Schema.String)
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({
    buildCmd = "npm run build",
    checkCmd = "npm outdated --json",
    directory,
    lockfile = "package-lock.json",
    testCmd = "npm test",
    typecheckCmd = "npx tsc --noEmit"
  }) =>
    Node.bindPlanned(
      ScanDependencies.call({ directory, checkCmd, lockfile }),
      (scan: Planned.Planned<typeof Scan.Type>) =>
        Node.branch(UpdateCandidates.child({ directory, outdated: scan.outdated }), {
          if: (updates) => updates.length > 0,
          then: (updates) =>
            Node.bindPlanned(
              Verify.call({ directory, typecheckCmd, testCmd, buildCmd }),
              (verify: Planned.Planned<typeof Verification.Type>) =>
                Node.map(Node.succeed({ scan, updates, verify }), report)
            ),
          else: (updates) => Node.map(Node.succeed({ scan, updates, verify: null }), report)
        })
    )
})

/** Every agent step the flow calls, and the child flow it starts. The host implements {@link Verify}. */
export const layer = Layer.mergeAll(
  ScanDependencies.layer,
  UpdateDependency.layer,
  Interpreter.layer(UpdateCandidates)
)
