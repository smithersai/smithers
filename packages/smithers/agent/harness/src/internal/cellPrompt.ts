/**
 * The one contract the cell-first harness teaches a model.
 *
 * This contract is plain JavaScript over `ctx.call`, shaped to look like the
 * Claude Code workflow API, and that is a ruling rather than an accident: will
 * ruled on 2026-08-20 that the model authoring surface stays this shape,
 * because agents perform better on the shape they are trained on. Effect.ts is
 * the language of the code we maintain, not the language the model writes. Do
 * not port this contract onto `Flow`/`Action`/`Node`; that was built out under
 * a 2026-08-12 ruling and reversed. It may be tested later as a benchmark arm
 * and is adopted only if it benchmarks better.
 *
 * There is one contract, and it is the REPL's. The surface it replaced — a cell
 * as the body of its own async function, filing JSON into `state` and choosing
 * its successor's `context` by hand — is recorded as a design error rather than
 * as an arm that lost: it made the model do the realm's job, which is why it
 * never worked like a REPL. will ruled it out on 2026-08-24. The evidence and
 * the ruling are in `../../docs/concepts.md#repl-realm`.
 *
 * The teaching here is measured, not preferred, and the measurement has now run
 * both ways. The merged optimal-trace program
 * predicted that more teaching
 * would buy verdicts, and grew the contract it replaced from 8,197 to 11,312
 * characters across changes 2, 9 and 10. The re-run that settles those
 * predictions says it did not:
 * resolved fell 35/45 to 30/45, cost rose 59 %, and five instances spent a whole
 * 1,200 s budget without editing one byte, held there by an unconditional
 * pre-edit reproduction rule. The same wave shows every *tool* change paying.
 * That is why the rules below carry their traces and why a teaching change is
 * made one at a time.
 *
 * The exception rule 8 used to state — "when the command will not bootstrap,
 * edit on the diagnosis you have and establish the proof afterwards" — is gone,
 * and it is gone because the thing it was managing no longer exists. It existed
 * to relieve an *ordering*: a baseline had to be taken before the edit, so a
 * baseline that could not be taken yet blocked the edit. Checkpoints remove the
 * ordering outright (will, 2026-08-24). The baseline is now taken after the
 * edit, against `ctx.base`, so there is nothing left to make conditional and a
 * sentence offering relief from a constraint the contract no longer imposes is
 * teaching a shape that is not the shape.
 *
 * The same ruling is why the worked examples put the edit first and the
 * baseline second. That ordering is the whole of the failure it kills: on
 * `sympy__sympy-13878` the r95repl lane applied one byte-identical
 * 4,789-character patch five times, four of those applications preceded by
 * `git checkout -- sympy/stats/crv_types.py`, because a clean fails-before
 * proof required reverting the very work it was meant to prove. Models imitate
 * the example, and the example now shows a run that never gives its work back.
 *
 * The environment facts a host can compute (change 9) stay in full: they cost
 * the agent nothing to read and removed a whole class of archaeology.
 *
 * Each rule below carries the failure it was written against; do not soften one
 * without the trace that says the failure stopped happening, and do not add one
 * without a trace that says teaching — rather than a tool — is the gap.
 *
 * Governing design: `../../docs/concepts.md#model-authoring-surface` (the
 * ruling) and `../../docs/concepts.md#agent-cell-context` (the surface).
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Option } from "effect"
import type * as Cell from "../Cell.ts"
import { untrustedData } from "./untrustedData.ts"

/**
 * One rendered prompt section, with the digest that identifies its
 * content.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Section {
  readonly id: "cell-contract" | "cell-environment" | "cell-catalog"
  readonly text: string
  readonly digest: string
}

/**
 * Facts about the container a run executes in, computed by the harness.
 *
 * Every field is something the host can read off the environment without
 * knowing anything about the task, which is the whole admission rule: the
 * program that motivated this section rejects instance-specific teaching
 * outright, so the shape is a closed set of typed fields rather than free
 * prose a caller could smuggle an answer into. Facts that are absent are not
 * rendered; the run discovers them the ordinary way.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Environment {
  /** The container's locale and encoding, as `LANG`/`LC_ALL` report it. */
  readonly locale?: string
  /** Tools a run will reach for that this image does not install. */
  readonly absentTools?: ReadonlyArray<string>
}

/**
 * The contract every run is taught.
 *
 * It is the contract that replaced the filing one, and the difference is exactly
 * the difference in the surface: there is no returned object to describe, no
 * `state` to file, no manifest to read, and no `render`/`recall` to name,
 * because the variable is the memory and the print is the summary.
 *
 * Every rule with a trace behind it was carried across byte-similar when the
 * surface changed, and that was deliberate: the r91 rerun grew the old contract
 * from 8,197 to 11,312 characters and dropped resolved from 35/45 to 30/45 at
 * 59 % more cost, which says teaching changes are expensive and must be measured
 * one at a time. A wave that changed the realm *and* re-cut the doctrine could
 * not attribute its own result. Cutting further is its own arm, with its own
 * wave.
 *
 * The second worked example is the golf report's own prescription — its
 * class-(a) finding is that the contract's only worked example is a three-line
 * toy, and models imitate the example.
 *
 * It moved a second time on 2026-08-24, when checkpoints landed: the baseline
 * moved after the edit in the example and rule 9 names `ctx.base`. Both pinned
 * numbers moved with it.
 *
 * The completion teaching first moved after the first REPL wave, and the change
 * is stated rather than smuggled. What died is the see-then-attest rule
 * ("complete only once you have SEEN that identical command pass"): it asked for
 * a memory of a result and got one, and `sympy__sympy-13878` ended by claiming
 * in `output` that a suite "exited 0 and printed its passing test summary" one
 * frame after its own guarded `ctx.done` had declined to fire because that suite
 * exited 1. What replaces it is the shape the model had already written and
 * abandoned: complete behind a check of the result, `if (after.exitCode === 0)
 * ctx.done(...)`, so the verdict is read from the call rather than remembered
 * across a turn. An unguarded completion stays legal — sometimes nothing in the
 * image can be made to flip — and is named for what it is, a claim nobody
 * checked. That is will's ruling of 2026-08-23, and it is why the pinned length
 * in `test/CellPrompt.test.ts` moved.
 *
 * Task scoping moved on 2026-09-19 after a chat request to answer only A spent
 * twelve frames printing and then looking for an unrelated failing test.
 * The host already taught same-cell completion, but these rules required an
 * edit and a proving command unconditionally. The scoped contract completed
 * the retained natural-language opening in six of six probes, against four
 * of six for the old contract. A seeded six-print loop still did not recover
 * the exact answer; the unchanged read-only cap remains necessary. The edit,
 * baseline and tree-review requirements remain for requested workspace work.
 *
 * Governing design: `../../docs/concepts.md#repl-realm`.
 */
const replContract = `You advance this task one cell at a time, in a JavaScript REPL that stays alive for the whole run.

Every reply MUST contain a fenced block tagged \`cell\`, and nothing in it but JavaScript. Several \`cell\` blocks in one reply are concatenated in order and run as ONE program.

The realm persists. Everything a cell declares at the top level — \`const\`, \`let\`, \`var\`, \`function\`, \`class\` — is still bound, with the value it had, in every later cell of this run. Declaring a name again rebinds it. Nothing has to be filed and nothing has to be carried forward: you write ordinary code, across turns.

\`console.log\` is how you talk to your next turn. What a cell prints comes back to you at the top of the next one and stays in your context window for every later turn; what it does not print is still in the variable you put it in, to read or compute with whenever you want it.

Here is a bug-fix task in two cells. Names are illustrative — call what \`ctx.flows\` lists — and copy the shape when a bug fix is requested.

\`\`\`cell
const found = await ctx.call("grep", { pattern: "return value", root: "src/units", limit: 5 })
const hit = found.ok === false ? undefined : found.matches[0]   // a failed call resolves, it does not throw
const region = await ctx.call("read", { path: hit.file, offset: Math.max(1, hit.line - 20), limit: 40 })
console.log(region.content)                                     // the bytes I will choose the edit from
\`\`\`

\`\`\`cell
const verification = { flow: "bash", input: { command: "run-tests tests/test_widen.py::test_keeps_unit" } }
const anchor = hit.text                                         // a line a call returned, never typed from memory
const applied = await ctx.call("edit", { path: hit.file, oldString: anchor, newString: anchor.replace("return value", "return widen(value)") })
const before = await ctx.call(verification.flow, verification.input, { at: ctx.base })  // the tree this run opened on; the edit stays
const after = await ctx.call(verification.flow, verification.input)   // the identical command, on the tree you changed
console.log(applied.ok === false ? applied.error.message : applied.hunk, before.exitCode, after.exitCode, after.stdout)
if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(verification.input.command + " failed before the edit and exits 0 after it; the applied hunk is:\\n" + applied.hunk)
\`\`\`

Two frames: search, read, print — then edit, baseline at ctx.base, re-check, and finish behind the check that decides it. The same work at one call per frame costs six model turns and learns nothing extra.

Rules:

1. Your bindings are \`ctx\`, \`console\`, and everything your earlier cells defined. \`ctx.call(name, input)\` runs a flow and resolves with its result; \`ctx.flows\` is the catalog of flows you may call. There is nothing else — no imports, no require, no fetch, no filesystem, no process, no Date, no Math.random. Referencing anything else throws. This is about the JavaScript you write, not the strings you pass: a command or pattern that mentions another language's import, such as a Python heredoc reading \`from pathlib import Path\`, is data and is fine.
2. Everything effectful is a flow. Reading a file, running a command, remembering something, asking a question, delegating to a subagent: all of them are \`ctx.call\`.
3. Calls are ordinary awaits, so derive later inputs from earlier results inside one cell instead of spending a frame per call. A failed call does not throw: it resolves with \`{ ok: false, error: { code, message, hint } }\`, so the branch you already wrote still runs — test \`.ok === false\` where you are unsure. A successful call resolves with the flow's own result, unwrapped. If a cell throws, every name it had already assigned keeps its value and the next cell carries on from there. Long calls are fine: a suite that runs for minutes spends the flow's budget, never your cell's. Captured output is capped, so a result flagged truncated is a fragment: to restore a file from git run git checkout or git restore on the path, and never route file content through captured stdout — a write of bytes a call returned truncated is refused.
4. Print what you must read; keep what you must compute with. Every turn opens with what your last cell printed, the names your realm holds, and one line for each call this run has settled — including which of them wrote to the tree, and whether a write repeats one you already made. Prints are bounded and arrive once; a variable is whole and stays. Print the excerpt you will choose an edit from and the output of the check you are judging; do not print a file to save it, because it is already saved under the name you gave it. Every printed line is paid again on every later turn, so print at most about 40 lines a cell, and never a whole listing, search result, file or intermediate value. Print counts and paths first, \`const files = [...new Set(hits.matches.map((m) => m.file))]; console.log(hits.matches.length, files.slice(0, 15))\`, not \`console.log(hits)\` or a table of every hit, then read only the region you chose. When \`ctx.flows\` lists \`jev\`, let it make the judgment code cannot, such as which of those files implement the feature, instead of printing them to judge yourself. Structures print as JSON, and a list of records prints as a table with its columns named once, so there is no \`String()\` to do and no \`[object Object]\` to get wrong.
5. Finish by calling. \`ctx.done(output)\` ends the run and \`output\` is the answer; \`ctx.park(reason, message)\` waits durably for a human, with \`reason\` one of "waiting-input", "waiting-event", "waiting-quota", and a run with nobody listening refuses it and hands the question back. Both take effect where you call them: the run is over at that line, a later \`ctx.call\` in the same cell resolves \`{ ok: false, error: { code: "run_completed" } }\` without running, and the rest of the cell runs out harmlessly. For a conversational request, call \`ctx.done(answer)\` directly. For a read-only request, call \`ctx.done(answer)\` when the observations answer it. Neither requires an edit, a command, a baseline, or a tree review merely to finish. \`console.log\` alone does not finish the run. When the task requires a workspace change, finish behind the check that decides it: write \`if (after.exitCode === 0) ctx.done(...)\` and let the call you just made decide. Let the guard read the tree too: run \`git status --porcelain\` and \`git diff\` in the completing cell, and finish silently only when the check passes AND the diff holds exactly the files you meant to change; otherwise \`console.log\` that diff, so the next frame sees what is actually in the tree. A bare \`ctx.done\` is allowed. If it claims work no check verified, it is a claim nobody checked: say what remains unverified. For claimed checks, name the exact command and what it printed on the run you actually made. A cell that calls neither ends its turn, and you get another.
6. A resumed run re-executes your cells from the top to rebuild the realm; calls that already settled return their recorded results instead of running twice.
7. For a bug-fix claim, a command becomes evidence only once you have SEEN it fail on the unmodified tree FOR THE RIGHT REASON, which is the bug itself. A command that fails because it names a test, file, module, environment, or program that does not exist reproduces nothing: it fails identically on a broken tree and on a fixed one. Results carry \`invalidProbe\` when the flow can tell, but the reading is yours — repair such a probe, by listing the real names first, before you rely on it. Hold the check that failed for the right reason in a variable called \`verification\`, as \`{ flow, input }\`, and reuse that exact pair after edits rather than deriving or broadening another command.
8. When the task requires a workspace change, act, then verify: read broadly in ONE cell, then commit to an edit. A run may be stopped for spending too many consecutive frames that write nothing, and when that budget is close the harness says so and asks for either an edit or \`ctx.justify("<the evidence you are still missing, the exact call that will get it, and what that makes the next frames do differently>")\`. An edit answers with the hunk it applied, raw and correctly indented: print it in the same cell, because a bad edit costs one glance there and a whole investigation anywhere else. Then put each edited file through whatever language-aware checker \`ctx.flows\` and this image actually offer (a compiler, ruff, eslint/tsc — through the shell flow); undefined-name findings are advisory — fix them before any broad suite, and where none exists record that and continue rather than guessing with regex.
9. For a bug-fix claim, prove it before you claim it, in as few frames as you can. ONE cell may make the edit, run the baseline check against \`ctx.base\` — the tree this run opened on, always there, free — and re-run the identical check on the tree you just changed. A baseline you have watched fail is what buys a same-cell \`ctx.done\`, and \`{ at: ctx.base }\` is how you take one without giving up your work: a call at a checkpoint reads a tree that has already been and leaves your work exactly as you left it. NEVER undo your own edit to re-prove a baseline. \`ctx.checkpoint()\` pins the tree as it stands at that line, for a baseline of your own; a checkpoint is read-only, so a flow that writes is refused at one. Let the code read the verdict: \`if (before.exitCode !== 0 && after.exitCode === 0) ctx.done(...)\` finishes on the results this cell just took. A broad suite that was already green proves no bug changed, and a probe that could not find what it named proves nothing at all.
10. When \`ctx.flows\` lists \`jev\`, use it for any enumerable judgment over many items: classify, triage, rank, yes/no, pick-one, score. "Which of these 300 files touch auth", "is this failure related", "does this diff match the task" are each ONE call, with the items in \`state\` and one boolean, choice or score question per item, all answered in parallel in about 300 ms, far cheaper than reading them yourself. Pack the items into one call, never a call per item. Its answers are a probability, an option or a score, never text: do not ask it for code, prose or a quoted answer. Example: \`const judged = await ctx.call("jev", { state: { files }, questions: Object.fromEntries(files.map((f, i) => [String(i), { type: "boolean", instructions: "Does files[" + i + "] implement or call authentication?" }])) })\`, then \`files.filter((_, i) => judged.answers[String(i)].value)\`.

If a cell throws you are told what happened and you get another turn. If a cell does not PARSE nothing ran at all, so you are asked again inside the SAME frame, with the error and the offending line.`

const historyFact =
  `the checkout ends at the commit you were given, so the change this task asks for is not in local history and no branch, tag, stash or reflog here holds a later fix. Mining \`git log --all\` or \`git log -S\` for one costs a frame and returns nothing: this harness keeps its own attempt and durability snapshots in a repository of its own, so everything those commands can reach is real project history and all of it predates your task. A dangling commit is this harness pinning your own tree for a checkpoint, so \`git fsck\` reports your edit and never a fix. Reading history backwards is still cheap: \`git blame\` or \`git log -S\` on a line says what an assertion was written for, and when the task names a last-known-good release, \`git log <tag>..HEAD -- <paths>\` is the shortest route to the regression.`

const environmentText = (environment: Environment): string => {
  const lines = [`- History: ${historyFact}`]
  if (environment.locale !== undefined) {
    lines.push(
      `- Locale: ${environment.locale}. Command output and file bytes decode as that; do not spend a call establishing it.`
    )
  }
  const absent = environment.absentTools === undefined ? [] : [...environment.absentTools].sort()
  if (absent.length > 0) {
    lines.push(
      `- Not installed in this image: ${
        absent.join(", ")
      }. A call that invokes one fails; reach for what \`ctx.flows\` lists instead of discovering this by hand.`
    )
  }
  return `Facts this harness computed about the checkout and container. Nothing here is about the task itself.\n${
    lines.join("\n")
  }`
}

const digest = (id: Section["id"], text: string): string => Digest.digest(CanonicalJson.stringify({ id, text }))

type CatalogProjection = Cell.FlowProjection & Partial<Pick<Descriptor.FlowDescriptor, "provenance" | "path">>

const catalogText = (flows: Readonly<Record<string, CatalogProjection>>): string => {
  const names = Object.keys(flows).sort()
  if (names.length === 0) {
    return "No flows are callable in this run. Complete or park; ctx.call has nothing to reach."
  }
  const lines = names.map((name) => {
    const projection = flows[name]!
    const capabilities = projection.capabilities.length === 0
      ? ""
      : ` capabilities=${[...projection.capabilities].sort().join(",")}`
    const origin = JSON.stringify({
      source: projection.provenance?.source ?? "unknown",
      root: projection.provenance?.root,
      path: projection.path
    })
    const heading = `- ${name} (${projection.tier})${capabilities}: ${projection.description}\n  provenance: ${origin}`
    // The input schema is the difference between choosing a call and guessing
    // one. A rejected input costs a whole frame, so a catalog that names a
    // flow without saying what it takes spends the run's frame budget on
    // trial and error.
    return Option.isNone(projection.input)
      ? heading
      : `${heading}\n  input: ${JSON.stringify(projection.input.value)}`
  })
  return `Flows callable with ctx.call in this frame:\n${
    untrustedData(lines.join("\n"), "flow catalog (descriptor provenance follows)")
  }`
}

/**
 * Builds the three cell-contract teaching sections for one frame.
 *
 * The order is by how often each section changes, because every one of them is
 * a prefix segment and a prefix is only cached up to its first edit: the
 * contract is constant for the life of the binary, the environment for the life
 * of a run, and the catalog can differ frame to frame.
 *
 * `environment` carries what the host measured about the container. It is
 * optional because the epoch fact — a checkout has no future in it — holds
 * everywhere and is stated with or without a host that measures anything else.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  flows: Readonly<Record<string, CatalogProjection>>,
  environment: Environment = {}
): ReadonlyArray<Section> => {
  const facts = environmentText(environment)
  const catalog = catalogText(flows)
  const taught = replContract
  return [
    { id: "cell-contract", text: taught, digest: digest("cell-contract", taught) },
    { id: "cell-environment", text: facts, digest: digest("cell-environment", facts) },
    { id: "cell-catalog", text: catalog, digest: digest("cell-catalog", catalog) }
  ]
}
