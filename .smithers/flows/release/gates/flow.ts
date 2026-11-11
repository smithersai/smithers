/**
 * `release/gates`: run the release-validation inventory, every build-graph
 * gate a release candidate must pass, one durable action call per gate.
 *
 * The inventory is `release-gates.mjs`, partitioned for this host by
 * `releaseGateSetForHost`. Gates run serially in inventory order. A red gate
 * does not stop the rest, so one run reports every red gate; the run then
 * fails with {@link GatesFailed} naming them. On success it returns the gate
 * receipt: every gate that ran and every declared exception that did not.
 * `resultsDirectory` makes each gate write `--results-file
 * <resultsDirectory>/<gate>.json`.
 *
 * `.github/workflows/release.yml` runs the gates through this flow, and the
 * release flow's checks step runs them through the same {@link runReleaseGates}.
 *
 * ```sh
 * smthrs flow start release/gates --wait
 * smthrs flow start release/gates --data '{"resultsDirectory":"dist/gate-results"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import * as Fault from "@smthrs/flow/Fault"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { repositoryRoot } from "../../automation/run-module.ts"
import { inheritingRunner, type RunCommand } from "../../release-support/io.ts"
import { GateEvidence } from "../../release-support/schema.ts"
import { releaseGateArgs, releaseGateResultsFile, releaseGateSetForHost } from "../release-gates.mjs"

/**
 * Where each gate writes its results file, when given.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  resultsDirectory: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * One or more gates failed; `red` names them in inventory order.
 *
 * @since 1.0.0
 * @category errors
 */
export class GatesFailed extends Schema.TaggedError<GatesFailed>()("release/GatesFailed", {
  red: Schema.Array(Schema.String)
}) {
  override get message() {
    return `${this.red.length} release gate(s) failed: ${this.red.join(", ")}`
  }
}
// A red gate is a finding about the candidate, not the host.
Fault.register("release/GatesFailed", "user")

/**
 * The gate inventory this host runs and the exceptions it reports.
 *
 * @since 1.0.0
 * @category models
 */
export type ReleaseGateSet = ReturnType<typeof releaseGateSetForHost>

/**
 * The receipt for a gate set, as `gate-evidence.json` spells it.
 *
 * @since 1.0.0
 * @category constructors
 */
export const gateReceipt = (gates: ReleaseGateSet): GateEvidence => ({
  ran: gates.inventory.map((gate) => gate.name),
  exceptions: gates.exceptions.map(({ name, command, reason }) => ({ name, command, reason }))
})

/**
 * One gate as it runs: its inventory name and its `smthrs` arguments.
 *
 * @since 1.0.0
 * @category models
 */
export const GateCall = Schema.Struct({ name: Schema.String, args: Schema.Array(Schema.String) })

/**
 * The calls for a gate set, in order, each writing a results file under
 * `resultsDirectory` when given.
 *
 * @since 1.0.0
 * @category constructors
 */
export const gateCalls = (
  gates: ReleaseGateSet,
  resultsDirectory?: string
): ReadonlyArray<typeof GateCall.Type> =>
  gates.inventory.map((gate) => ({
    name: gate.name,
    args: releaseGateArgs(
      gate,
      resultsDirectory === undefined ? {} : { resultsFile: releaseGateResultsFile(resultsDirectory, gate) }
    )
  }))

/**
 * Run one gate as `pnpm exec smthrs <args>`. It succeeds with `red`, the names
 * of the gates already red, with this gate's name appended when the command
 * fails, so a red gate never stops the next. Interruption is not a red gate:
 * it stops the run.
 *
 * @since 1.0.0
 * @category constructors
 */
export const runGate = (
  run: RunCommand,
  gate: typeof GateCall.Type,
  red: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: (signal) => run("pnpm", ["exec", "smthrs", ...gate.args], { signal }),
    catch: (cause) => cause
  }).pipe(
    Effect.as(red),
    Effect.catch((cause) =>
      Effect.logError(`Release gate failed: ${gate.name}`, cause).pipe(Effect.as([...red, gate.name]))
    )
  )

/**
 * The receipt when no gate is red, else {@link GatesFailed} naming them.
 *
 * @since 1.0.0
 * @category constructors
 */
export const verdict = (red: ReadonlyArray<string>, receipt: GateEvidence): Effect.Effect<GateEvidence, GatesFailed> =>
  red.length === 0 ? Effect.succeed(receipt) : Effect.fail(new GatesFailed({ red }))

/**
 * Every gate of a set, serially, then the {@link verdict}: the release flow's
 * checks step. This flow runs the same {@link runGate} and {@link verdict},
 * one action call each.
 *
 * @since 1.0.0
 * @category constructors
 */
export const runReleaseGates = (
  run: RunCommand,
  gates: ReleaseGateSet = releaseGateSetForHost()
): Effect.Effect<GateEvidence, GatesFailed> =>
  Effect.gen(function*() {
    let red: ReadonlyArray<string> = []
    for (const gate of gateCalls(gates)) red = yield* runGate(run, gate, red)
    return yield* verdict(red, gateReceipt(gates))
  })

const implementationVersion = "release/gates/v1"

/**
 * Runs one gate; succeeds with the red gate names so far.
 *
 * @since 1.0.0
 * @category actions
 */
export const Gate = Action.make("release/gates/gate", {
  implementationVersion,
  payload: { gate: GateCall, red: Schema.Array(Schema.String) },
  success: Schema.Array(Schema.String),
  nondeterministic: true
})

/**
 * Fails naming every red gate, or returns the receipt.
 *
 * @since 1.0.0
 * @category actions
 */
export const Verdict = Action.make("release/gates/verdict", {
  implementationVersion,
  payload: { red: Schema.Array(Schema.String), receipt: GateEvidence },
  success: GateEvidence,
  error: GatesFailed
})

/**
 * The implementations over a command runner; tests inject one.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerWith = (run: RunCommand) =>
  Layer.mergeAll(
    Gate.toLayer(({ gate, red }) => runGate(run, gate, red), { implementationVersion }),
    Verdict.toLayer(({ red, receipt }) => verdict(red, receipt), { implementationVersion })
  )

/**
 * The implementations against this checkout. A gate's output goes straight to
 * this process's terminal or CI log.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = layerWith(inheritingRunner(repositoryRoot(new URL(import.meta.url))))

/** Each gate's call consumes the red names its predecessor returned, so they run one at a time, in order. */
const serially = (
  calls: ReadonlyArray<typeof GateCall.Type>,
  receipt: GateEvidence,
  red: Parameters<typeof Gate.call>[0]["red"] = []
): Node.Node<GateEvidence, GatesFailed, Action.Requirement<typeof Gate.name | typeof Verdict.name>> => {
  const [gate, ...rest] = calls
  return gate === undefined
    ? Verdict.call({ red, receipt })
    : Node.bindPlanned(Gate.call({ gate, red }), Node.capture({}, (next) => serially(rest, receipt, next)))
}

export default Flow.make("release/gates", {
  description: "Run every release gate in the shared inventory and fail naming each red one.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:pnpm *"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: GateEvidence,
  error: GatesFailed,
  // The host's gate set is part of the graph's identity: a changed inventory is a new graph.
  body: Node.capture({ implementationVersion, gates: releaseGateSetForHost() }, function(request) {
    return serially(gateCalls(this.gates, request.resultsDirectory), gateReceipt(this.gates))
  })
})
