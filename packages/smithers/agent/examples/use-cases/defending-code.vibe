/**
 * Find memory-safety bugs in a C target by crashing it under AddressSanitizer, then patch them.
 *
 * Port of the 0.x `defending-code/workflow.jsx`, itself a port of Anthropic's
 * defending-code reference harness. Seven stages run in order: build the
 * target with ASAN, recon its input-parsing subsystems, fan out one finder per
 * subsystem, re-verify each crash independently, dedupe the verified crashes
 * into unique bugs, write one report per bug, and patch every bug in one pass.
 * A broken build, no verified crash, or no unique bug skips the stages after
 * it, and a summary always reports the counts. Each fan-out runs `fanout`
 * agents at a time (default 3), and a failing finder, verifier or reporter
 * drops only its own result.
 *
 * 0.x derived the working copy from `ctx.runId`; a 1.0 body cannot read its execution id, so the payload names the run.
 * 0.x's build was a compute task running `harness/build.sh`; here it is a declared action a host implements, and the harness, the target and its ground truth are not ported.
 * 0.x rendered each fan-out once its input landed; here each runs in a `.child()` flow whose body plans over the real list.
 * 0.x ran the agents as Claude Code with `yolo`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 * 0.x's `DEFENDING_CODE_FANOUT` is the `fanout` payload field, and its model override is the step seat.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The committed, vulnerable source. The run builds and patches a copy. */
export const targetSource = "targets/card-parser/src/card_parser.c"

const Count = Schema.Int

/** The ASAN build of the run's working copy. */
export const Build = Schema.Struct({
  ok: Schema.Boolean,
  binaryPath: Schema.String,
  sourcePath: Schema.String,
  log: Schema.String
})

/** A broken build. 0.x threw so the run failed loudly instead of reporting zeros. */
export class BuildFailed extends Schema.TaggedError<BuildFailed>()("examples/DefendingCode/BuildFailed", {
  log: Schema.String
}) {}

/** One input-parsing subsystem worth fuzzing. */
export const Subsystem = Schema.Struct({
  id: Schema.String.annotate({ description: "short lowercase slug, e.g. name" }),
  name: Schema.String,
  hypothesis: Schema.String
})

/** The recon agent's answer. */
export const Recon = Schema.Struct({ subsystems: Schema.Array(Subsystem), notes: Schema.String })

/** One finder's result. */
export const Find = Schema.Struct({
  subsystemId: Schema.String,
  crashed: Schema.Boolean,
  crashKind: Schema.String.annotate({ description: "ASAN class, or none" }),
  crashSite: Schema.String.annotate({ description: "file:line in function" }),
  pocPath: Schema.String,
  pocInput: Schema.String.annotate({ description: "exact file contents that crash" }),
  reproCount: Count.annotate({ description: "crashes out of attempts" }),
  attempts: Count
})

/** One independent re-verification. */
export const Verify = Schema.Struct({
  subsystemId: Schema.String,
  reproduced: Schema.Boolean,
  reproCount: Count,
  crashKind: Schema.String,
  crashSite: Schema.String,
  note: Schema.String
})

/** One unique root-cause bug. */
export const UniqueBug = Schema.Struct({
  bugId: Schema.String.annotate({ description: "e.g. BUG-1" }),
  crashKind: Schema.String,
  crashSite: Schema.String,
  rootCause: Schema.String,
  representativeSubsystemId: Schema.String,
  representativePoc: Schema.String,
  duplicateCount: Count
})

/** The judge's clustering. */
export const Dedupe = Schema.Struct({
  uniqueBugs: Schema.Array(UniqueBug),
  totalVerified: Count,
  totalUnique: Count
})

/** One exploitability writeup. */
export const Report = Schema.Struct({
  bugId: Schema.String,
  title: Schema.String,
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  primitive: Schema.String,
  reachability: Schema.String,
  impact: Schema.String,
  writeup: Schema.String
})

/** The fix and its proof. */
export const Patch = Schema.Struct({
  filesChanged: Schema.Array(Schema.String),
  diff: Schema.String,
  bugsFixed: Schema.Array(Schema.Struct({ bugId: Schema.String, pocNoLongerCrashes: Schema.Boolean })),
  rebuildOk: Schema.Boolean,
  smokeTestOk: Schema.Boolean,
  allValidated: Schema.Boolean,
  note: Schema.String
})

/** The roll-up the flow settles with. */
export const Summary = Schema.Struct({
  subsystemsProbed: Count,
  crashesFound: Count,
  verified: Count,
  uniqueBugs: Count,
  bugsFixed: Count,
  patchValidated: Schema.Boolean,
  headline: Schema.String
})

type Subsystem = typeof Subsystem.Type
type Find = typeof Find.Type
type Verify = typeof Verify.Type
type UniqueBug = typeof UniqueBug.Type
type Report = typeof Report.Type
type Patch = typeof Patch.Type
type Summary = typeof Summary.Type

/** Compiles the target with ASAN into the run's throwaway copy. */
export const BuildTarget = Action.make("examples/DefendingCode/Build", {
  payload: { source: Schema.String, work: Schema.String, binary: Schema.String },
  success: Build,
  error: BuildFailed
})

/** Proposes the subsystems to fuzz. */
export const ReconTarget = AgentAction.make("examples/DefendingCode/Recon", {
  payload: { work: Schema.String },
  output: Recon,
  seat,
  system: [
    "You are a security recon agent. You read C source and identify the input-parsing subsystems most likely to contain memory-safety bugs. You do not modify files."
  ],
  prompt: ({ work }) =>
    `Recon the target program before fuzzing.

Read the source at ${work}/card_parser.c and the target config at
targets/card-parser/config.yaml.

Identify the distinct input-parsing subsystems that an attacker-controlled input
file reaches. Each is a separate place where bytes from the file are copied or
stored. For every subsystem give a short lowercase slug id (e.g. "name"), a human
label, and a one-sentence hypothesis for why it might be memory-unsafe.

List each independent subsystem separately so they can be fuzzed in parallel. Do
not modify any files.`
})

/** Crafts inputs against one subsystem until ASAN crashes the target 3/3 times. */
export const FindBug = AgentAction.make("examples/DefendingCode/Find", {
  payload: { subsystem: Subsystem, work: Schema.String, binary: Schema.String },
  output: Find,
  seat,
  timeout: "10 minutes",
  system: [
    "You are a vulnerability-discovery agent. You craft malformed inputs and run a target under AddressSanitizer until it crashes, then minimize and confirm the crash. You only write proof-of-concept input files; you never edit the target source."
  ],
  prompt: ({ binary, subsystem, work }) =>
    `Find a memory-safety bug in ONE subsystem of the target.

Subsystem: ${subsystem.name} (id: ${subsystem.id})
Hypothesis: ${subsystem.hypothesis}

Binary (built with AddressSanitizer): ${binary}
Source (read-only): ${work}/card_parser.c

Run any input through the ASAN harness like this:
    sh harness/run_target.sh ${binary} <input-file>
It always exits 0 and prints a final status line:
    STATUS=CRASH KIND=<asan-class> EXIT=...   you triggered a memory bug
    STATUS=OK EXIT=0                          no crash, so refine and retry

The input is a line-based "contact card":
    NAME: <value>
    EMAIL: <value>
    TAGS: <comma,separated,list>

Steps:
1. Read ${work}/card_parser.c and study how the "${subsystem.id}" field is parsed.
2. Write a candidate input that targets the "${subsystem.id}" field to
   ${work}/poc-${subsystem.id}.card
3. Run it through the harness. If STATUS is not CRASH, refine (longer values,
   more list items) and try again.
4. Once it crashes, run it 3 more times and confirm it crashes all 3 times.
   Record the "SUMMARY: AddressSanitizer: <class>" line and the crash site
   (file:line in function).
5. Keep the PoC minimal. Report subsystemId="${subsystem.id}", whether it crashed, the
   ASAN class, the crash site, the PoC path, the exact PoC file contents, how
   many of your attempts reproduced, and the total attempts. If you genuinely
   cannot crash it, report crashed=false.`
})

/** Reproduces one reported crash from scratch, as the grader. */
export const VerifyCrash = AgentAction.make("examples/DefendingCode/Verify", {
  payload: { find: Find, work: Schema.String, binary: Schema.String },
  output: Verify,
  seat,
  timeout: "5 minutes",
  system: [
    "You are an independent crash-verification agent (the grader). You reproduce a reported crash from scratch in fresh processes and report honestly whether it reproduces. You never edit the target source."
  ],
  prompt: ({ binary, find, work }) =>
    `Independently verify a reported crash. Do not trust the finder; reproduce
it yourself.

Reported by subsystem "${find.subsystemId}": ${find.crashKind} at ${find.crashSite}

The proof-of-concept input is:
-----
${find.pocInput}
-----

1. Write that exact input to ${work}/verify-${find.subsystemId}.card
2. Run it through the harness THREE times in fresh processes:
       sh harness/run_target.sh ${binary} ${work}/verify-${find.subsystemId}.card
3. Report reproduced=true only if all 3 runs print STATUS=CRASH with the same
   ASAN class. Report the class, the crash site, how many of the 3 runs crashed,
   and subsystemId="${find.subsystemId}".`
})

/** Clusters verified crashes into unique bugs. */
export const DedupeCrashes = AgentAction.make("examples/DefendingCode/Dedupe", {
  payload: { verified: Schema.Array(Verify) },
  output: Dedupe,
  seat,
  system: [
    "You are a triage judge. You compare verified crashes and cluster them into unique bugs by root cause and crash site, separating genuinely distinct bugs from duplicates."
  ],
  prompt: ({ verified }) =>
    `Cluster verified crashes into unique bugs.

Verified findings: ${JSON.stringify(verified)}

Two findings are the SAME bug if they share a root cause and crash site (e.g. the
same unbounded copy reached two ways). Findings at different sites/functions are
DIFFERENT bugs. Assign each unique bug an id ("BUG-1", "BUG-2", ...), its ASAN
class, crash site, a one-line root cause, the subsystem id of a representative
finding, that finding's PoC input, and how many verified findings collapsed into
it. Also report the total number of verified findings and the total unique bugs.`
})

/** Writes one exploitability analysis. */
export const ReportBug = AgentAction.make("examples/DefendingCode/Report", {
  payload: { bug: UniqueBug, work: Schema.String },
  output: Report,
  seat,
  timeout: "5 minutes",
  system: [
    "You are a security analyst. You write concise, accurate exploitability writeups for confirmed memory-safety bugs."
  ],
  prompt: ({ bug, work }) =>
    `Write an exploitability analysis for one confirmed bug.

${bug.bugId}: ${bug.crashKind} at ${bug.crashSite}
Root cause: ${bug.rootCause}

Read the relevant code in ${work}/card_parser.c, then produce: a short title, a
severity (low | medium | high | critical), the memory primitive the attacker
gains (what is overwritten and with what control), the reachability (how input
from the file reaches the bug), the impact, and a concise markdown writeup.
Report bugId="${bug.bugId}".`
})

/** Fixes every bug, rebuilds, and re-grades the PoCs and the smoke test. */
export const PatchBugs = AgentAction.make("examples/DefendingCode/Patch", {
  payload: { bugs: Schema.Array(UniqueBug), work: Schema.String },
  output: Patch,
  seat,
  timeout: "15 minutes",
  system: [
    "You are a security engineer. You fix memory-safety bugs with minimal, idiomatic C changes, then prove the fix by rebuilding and re-running the proof-of-concept inputs and the smoke test."
  ],
  prompt: ({ bugs, work }) =>
    `Fix every confirmed bug, then prove the fixes.

Bugs to fix:
${
      bugs.map((bug) =>
        `- ${bug.bugId}: ${bug.crashSite} (${bug.rootCause})\n  PoC:\n${
          bug.representativePoc.split("\n").map((line) => "    " + line).join("\n")
        }`
      ).join("\n")
    }

The vulnerable working copy is ${work}/card_parser.c. The pristine original is
${targetSource} (leave it untouched, and diff against it).

1. Edit ${work}/card_parser.c to fix ALL the bugs with minimal, idiomatic C
   (bound every copy; keep valid cards parsing). Do not change behavior for
   well-formed input.
2. Rebuild:  sh harness/build.sh ${work}/card_parser.c ${work}/card_parser
3. For EACH bug, write its PoC to a file and confirm it now prints STATUS=OK:
       sh harness/run_target.sh ${work}/card_parser <poc-file>
4. Confirm well-formed input still parses by running the smoke test against
   your rebuilt binary:
       sh targets/card-parser/smoke_test.sh ${work}/card_parser
   It must print SMOKE_OK and exit 0.
5. Produce a unified diff:
       diff -u ${targetSource} ${work}/card_parser.c

Report filesChanged, the unified diff, a bugsFixed entry per bug (bugId +
pocNoLongerCrashes), rebuildOk, smokeTestOk, allValidated (true only if rebuild +
smoke + every PoC fixed), and a one-line note.`
})

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/**
 * Keeps the first item per key. 0.x keyed its fan-out task ids by model-authored
 * strings, so two that slug alike would collide; the members here are keyed the
 * same way.
 */
const uniqueBy = <A>(items: ReadonlyArray<A>, keyOf: (item: A) => string): ReadonlyArray<A> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The crashes worth verifying: one per subsystem slug. */
const crashedOf = (finds: ReadonlyArray<Find>) => uniqueBy(finds.filter((f) => f.crashed), (f) => slug(f.subsystemId))

/** The crashes the grader reproduced. */
const verifiedOf = (verifies: ReadonlyArray<Verify>) => verifies.filter((v) => v.reproduced)

/** The bugs worth reporting and patching: one per bug id slug. */
const bugsOf = (dedupe: typeof Dedupe.Type) => uniqueBy(dedupe.uniqueBugs, (b) => slug(b.bugId))

/**
 * Runs one member per key at most `fanout` at a time. 0.x `continueOnFail`: a
 * failing member settles as null and only its own result is dropped.
 */
const fanOut = <A, R>(
  members: Readonly<Record<string, Node.Node<A, AgentAction.AgentFailure, R>>>,
  fanout: number,
  keep: (value: unknown) => value is A
): Node.Node<ReadonlyArray<A>, never, R> => {
  const caught = Object.fromEntries(
    Object.entries(members).map(([key, call]) => [key, Node.catch(call, { onFailure: () => Node.succeed(null) })])
  )
  const joined = Bounded.all(caught, { concurrency: fanout })
  return Node.map(joined, (settled) => Object.values(settled).filter(keep))
}

const Fanout = Schema.Int.check(Schema.isGreaterThan(0))

/** Fans the finders out over the recon's subsystems. */
export const FindAll = Flow.make("examples/DefendingCode/FindAll", {
  payload: { subsystems: Schema.Array(Subsystem), work: Schema.String, binary: Schema.String, fanout: Fanout },
  success: Schema.Array(Find),
  body: ({ binary, fanout, subsystems, work }) => {
    const unique = uniqueBy(subsystems, (s: Subsystem) => slug(s.id))
    if (unique.length === 0) return Node.succeed([])
    return fanOut(
      Object.fromEntries(
        unique.map((subsystem) => [`find-${slug(subsystem.id)}`, FindBug.call({ subsystem, work, binary })])
      ),
      fanout,
      Schema.is(Find)
    )
  }
})

/** Re-verifies each crash the finders reported. */
export const VerifyAll = Flow.make("examples/DefendingCode/VerifyAll", {
  payload: { finds: Schema.Array(Find), work: Schema.String, binary: Schema.String, fanout: Fanout },
  success: Schema.Array(Verify),
  body: ({ binary, fanout, finds, work }) => {
    const crashed = crashedOf(finds)
    if (crashed.length === 0) return Node.succeed([])
    return fanOut(
      Object.fromEntries(
        crashed.map((find) => [`verify-${slug(find.subsystemId)}`, VerifyCrash.call({ find, work, binary })])
      ),
      fanout,
      Schema.is(Verify)
    )
  }
})

/** Writes one report per unique bug. */
export const ReportAll = Flow.make("examples/DefendingCode/ReportAll", {
  payload: { bugs: Schema.Array(UniqueBug), work: Schema.String, fanout: Fanout },
  success: Schema.Array(Report),
  body: ({ bugs, fanout, work }) =>
    fanOut(
      Object.fromEntries(bugs.map((bug) => [`report-${slug(bug.bugId)}`, ReportBug.call({ bug, work })])),
      fanout,
      Schema.is(Report)
    )
})

/** What the roll-up reads: every stage that ran, and `undefined` for one that did not. */
interface Ran {
  readonly subsystems?: ReadonlyArray<Subsystem> | undefined
  readonly finds?: ReadonlyArray<Find> | undefined
  readonly verifies?: ReadonlyArray<Verify> | undefined
  readonly dedupe?: typeof Dedupe.Type | undefined
  readonly patch?: Patch | undefined
}

/** The roll-up. Pure, so it is a `Node.map`, not a step. */
const summarize = ({ dedupe, finds = [], patch, subsystems = [], verifies = [] }: Ran): Summary => {
  const crashed = crashedOf(finds)
  const bugs = dedupe === undefined ? [] : bugsOf(dedupe)
  return {
    subsystemsProbed: subsystems.length,
    crashesFound: crashed.length,
    verified: verifiedOf(verifies).length,
    uniqueBugs: bugs.length,
    bugsFixed: (patch?.bugsFixed ?? []).filter((b) => b.pocNoLongerCrashes).length,
    patchValidated: Boolean(patch?.allValidated),
    headline: patch?.allValidated === true
      ? `Found and patched ${bugs.length} unique memory-safety bug(s); all PoCs neutralized and the smoke test passes.`
      : `Found ${bugs.length} unique memory-safety bug(s) across ${crashed.length} crash(es).`
  }
}

type Requirements = Action.Requirement<
  `examples/DefendingCode/${"Build" | "Recon" | "Dedupe" | "Patch"}`
>

/** Rolls up whichever stages ran, holding planned references until they settle. */
const rollUp = (ran: object): Node.Node<Summary> => Node.map(Node.succeed(ran), (real) => summarize(real as Ran))

/** Dedupe, then report and patch when any unique bug survives. */
const triage = (
  work: string,
  fanout: number,
  ran: object,
  verified: Planned.Planned<ReadonlyArray<Verify>>
): Node.Node<Summary, AgentAction.AgentFailure, Requirements> =>
  Node.bindPlanned(
    DedupeCrashes.call({ verified }),
    (dedupe: Planned.Planned<typeof Dedupe.Type>) =>
      Node.branch(Node.map(Node.succeed(dedupe), bugsOf), {
        if: (bugs) => bugs.length > 0,
        then: (bugs) =>
          Node.andThen(
            ReportAll.child({ bugs, work, fanout }),
            Node.bindPlanned(PatchBugs.call({ bugs, work }), (patch: Planned.Planned<Patch>) =>
              rollUp({ ...ran, dedupe, patch }))
          ),
        else: () =>
          rollUp({ ...ran, dedupe })
      })
  )

/** The seven-stage pipeline. */
export const DefendingCode = Flow.make("examples/DefendingCode", {
  payload: { runId: Schema.String, fanout: Schema.optional(Fanout) },
  success: Summary,
  error: Schema.Union([AgentAction.AgentFailure, BuildFailed]),
  body: ({ fanout = 3, runId }) => {
    const work = `runs/${runId}`
    const binary = `${work}/card_parser`
    return Node.branch(BuildTarget.call({ source: targetSource, work, binary }), {
      if: (build) => build.ok,
      then: () =>
        Node.bindPlanned(ReconTarget.call({ work }), (recon: Planned.Planned<typeof Recon.Type>) =>
          Node.bindPlanned(
            FindAll.child({ subsystems: recon.subsystems, work, binary, fanout }),
            (finds: Planned.Planned<ReadonlyArray<Find>>) =>
              Node.bindPlanned(
                VerifyAll.child({ finds, work, binary, fanout }),
                (verifies: Planned.Planned<ReadonlyArray<Verify>>) => {
                  const ran = { subsystems: recon.subsystems, finds, verifies }
                  return Node.branch(Node.map(Node.succeed(verifies), verifiedOf), {
                    if: (verified) => verified.length > 0,
                    then: (verified) => triage(work, fanout, ran, verified),
                    else: () => rollUp(ran)
                  })
                }
              )
          )),
      else: () => Node.succeed(summarize({}))
    })
  }
})

/**
 * The agent steps and the three fan-out child flows. `BuildTarget` is the
 * host's: it supplies a `toLayer` that compiles the copy with ASAN.
 */
export const layer = Layer.mergeAll(
  ReconTarget.layer,
  FindBug.layer,
  VerifyCrash.layer,
  DedupeCrashes.layer,
  ReportBug.layer,
  PatchBugs.layer,
  Interpreter.layer(FindAll),
  Interpreter.layer(VerifyAll),
  Interpreter.layer(ReportAll)
)
