/**
 * Retained Effect handlers and migration refusals for the unified CLI.
 *
 * Cli.ts owns the public command tree. Its control commands delegate here,
 * and Compatibility.ts retains old spellings with their output contracts.
 * Local init, suggest, memory, MCP registration, and gateway hosting belong
 * exclusively to the Incur tree.
 *
 * @since 1.0.0
 */
import * as Canonical from "@smthrs/canonical/Canonical"
import { Control as ControlService, ControlError, ControlSchema } from "@smthrs/control"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as MigrateCommand from "@smthrs/migrate/flow/Command"
import { Ownership } from "@smthrs/run-store"
import { Clock, Console, Effect, Option, Schema, SchemaIssue, Stream } from "effect"
import { Argument, CliError as ParserError, Command, Flag, Prompt } from "effect/unstable/cli"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { resolve } from "node:path"
import * as ClaudeMirror from "./ClaudeMirror.ts"
import * as RunProgress from "./cli/RunProgress.ts"
import * as CliError from "./CliError.ts"
import * as BugCmd from "./commands/Bug.ts"
import * as DoctorCmd from "./commands/Doctor.ts"
import * as FlowCatalog from "./commands/FlowCatalog.ts"
import * as GcCmd from "./commands/Gc.ts"
import * as Globals from "./commands/Globals.ts"
import * as MigrateCmd from "./commands/Migrate.ts"
import * as UpdateCmd from "./commands/Update.ts"
import * as Detached from "./Detached.ts"
import * as Doctor from "./Doctor.ts"
import * as Environment from "./Environment.ts"
import * as ExecutorOwnership from "./ExecutorOwnership.ts"
import * as Forensics from "./Forensics.ts"
import * as Gc from "./Gc.ts"
import { defaultApprovalScope } from "./internal/ApprovalScope.ts"
import * as CommandStatus from "./internal/CommandStatus.ts"
import { causeLine } from "./internal/Failure.ts"
import * as FeaturedFlows from "./internal/FeaturedFlows.ts"
import * as History from "./internal/History.ts"
import * as NodeOutput from "./NodeOutput.ts"
import { Output, renderValue } from "./Output.ts"
import * as Project from "./Project.ts"
import * as Ui from "./Ui.ts"
import * as Unsupported from "./Unsupported.ts"
import * as Update from "./Update.ts"
import * as Verb from "./Verb.ts"

const global = {
  credential: Flag.string("credential").pipe(
    Flag.optional,
    Flag.withDescription("Bearer token for the remote control plane; prefer SMITHERS_API_KEY to avoid exposing argv")
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the machine-readable document instead of the human rendering")
  ),
  remote: Flag.string("remote").pipe(
    Flag.optional,
    Flag.withDescription("http(s) URL of the control plane to act on; falls back to SMITHERS_REMOTE")
  ),
  quiet: Flag.boolean("quiet").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Suppress banners and progress on stderr; stdout documents still print")
  ),
  silent: Flag.boolean("silent").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Suppress progress while preserving the command result")
  ),
  audience: Flag.choice("audience", ["auto", "human", "agent"] as const).pipe(
    Flag.withDefault("auto"),
    Flag.withDescription("Choose human or agent presentation; auto detects the calling harness")
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Show progress even when running inside an agent harness")
  ),
  // Declared here so the CLI's own flag validation accepts them; the values
  // are read from raw argv by `NodeControl.makeConfig`, which runs before the
  // durable layers are built.
  mcpConfig: Flag.string("mcp-config").pipe(
    Flag.optional,
    Flag.withDescription(
      "Path to the JSON array of MCP servers the local executor projects into a run's flow catalog"
    )
  ),
  root: Flag.string("root").pipe(
    Flag.optional,
    Flag.withDescription("Project root to act on, instead of walking up from the working directory")
  ),
  // Hidden, and the one removed flag with a supported value: `sqlite` names
  // the backend rc.0 has, so it is a no-op rather than a refusal.
  backend: Flag.string("backend").pipe(Flag.optional, Flag.withHidden)
}

const rootCommand = Command.make("smthrs").pipe(Command.withSharedFlags(global))

const input = Argument.string("key=value").pipe(Argument.variadic())
const data = Flag.string("data").pipe(
  Flag.optional,
  Flag.withDescription("Flow input as JSON; object members override key=value entries")
)
/** Required values are collected before the command opens durable services. */
const inputPrompt = (name: string, pickFlow = false) =>
  Effect.gen(function*() {
    const ui = yield* Ui.prompting
    const missing = new CliError.UsageError({
      message: `Missing required ${
        name.startsWith("--") ? "flag" : "argument"
      } <${name}>; use --wizard for guided input`
    })
    if (!ui.interactive) {
      return yield* Effect.fail(new ParserError.UserError({ cause: missing, userMessage: missing.message }))
    }
    // Discovery needs the command's Control layer. An empty value reaches
    // only the terminal handler, which replaces it with a catalog selection.
    if (pickFlow) return Prompt.succeed("")
    const value = yield* ui.text(`Enter ${name}`)
    if (Option.isNone(value)) return yield* Effect.interrupt
    return Prompt.succeed(value.value)
  })

const requiredArgument = (name: string, pickFlow = false) =>
  Argument.string(name).pipe(Argument.withFallbackPrompt(inputPrompt(name, pickFlow)))

const selectedFlow = (value: string) =>
  Effect.gen(function*() {
    if (value !== "") return value
    const ui = yield* Ui.prompting
    const control = yield* ControlService.Control
    const catalog = yield* flowCatalog(control)
    const flows = catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId))
    if (flows.length === 0) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: "No flows discovered; run smthrs init to create one" })
      )
    }
    const selected = yield* ui.pickSuggestion(flows, {
      message: "Choose a flow",
      label: (flow) => flow.flowId,
      hint: (flow) => flow.description
    })
    if (Option.isNone(selected)) return yield* Effect.interrupt
    return selected.value.flowId
  })

/**
 * Removed verbs that are registered by hand instead of by the loop below,
 * because `workflow list` is the `ls` alias.
 */
const ownGroupCommands = new Set(["workflow"])

/** One removed verb by name, so a handler cannot cite the wrong entry. */
const removedVerb = (name: string): Unsupported.RemovedVerb =>
  Unsupported.removedVerbs.find((verb) => verb.name === name)!

/** A hidden boolean flag whose presence is a refusal. */
const removedFlag = (parent: string, name: string) => Flag.boolean(name).pipe(Flag.withDefault(false), Flag.withHidden)

/** A hidden value flag whose presence is a refusal. */
const removedValueFlag = (name: string) => Flag.string(name).pipe(Flag.optional, Flag.withHidden)

/**
 * Fails when a removed flag was passed.
 *
 * Taking the whole flag record and the names to check keeps the refusal in one
 * place: a handler that forgot one would accept a flag the contract removed.
 */
const refuseRemoved = (
  parent: string,
  passed: Readonly<Record<string, boolean | Option.Option<string>>>
): Effect.Effect<void, CliError.UnsupportedError> => {
  for (const [name, value] of Object.entries(passed)) {
    const present = typeof value === "boolean" ? value : Option.isSome(value)
    if (present) return Effect.fail(Unsupported.flagError(Unsupported.findFlag(parent, name)))
  }
  return Effect.void
}

/**
 * The shared pre-handler: the globals every handler is checked against, and
 * the one notice every handler owes.
 *
 * The 0.x-project guard's detection is "when a command runs in a directory", so it belongs
 * here rather than in a verb. Wired into `ls` and `up` alone it printed only
 * when one of those two happened to be the first command an operator typed in
 * a 0.x project, because the first invocation writes `.flows/` and the sample
 * treats that as proof the project has moved on.
 */
const globalsOf = Effect.map(rootCommand, (root): Globals.Options => ({
  credential: Option.getOrUndefined(root.credential),
  backend: Option.getOrUndefined(root.backend),
  environment: process.env
}))

const guardGlobals = Effect.flatMap(globalsOf, Globals.guard)

const malformedJson = (label: string): CliError.UsageError =>
  new CliError.UsageError({ message: `${label} must be valid JSON` })

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

const schemaMismatch = (label: string, issue: SchemaIssue.Issue): CliError.UsageError => {
  // Approval payloads can carry capability material. Input reporting stays
  // disabled at the decoder, and this bounded formatter keeps only the path
  // and expectation an operator needs to repair one field.
  const detail = formatSchemaIssue(issue).split("\n").slice(0, 4).join("\n").slice(0, 800)
  return new CliError.UsageError({
    message: `${label} must match the expected payload schema:\n${detail}`
  })
}

const decodeJson = <A>(
  label: string,
  serialized: string,
  decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>
): Effect.Effect<A, CliError.UsageError> =>
  Effect.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: () => malformedJson(label)
  }).pipe(
    Effect.flatMap((decoded) =>
      decode(decoded).pipe(
        Effect.mapError((error) => schemaMismatch(label, error.issue))
      )
    )
  )

const decodeInput = (
  entries: ReadonlyArray<string>,
  raw: Option.Option<string>
): Effect.Effect<unknown, CliError.UsageError> => {
  const pairs = Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf("=")
    return separator < 1 ? [entry, true] : [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  if (Option.isNone(raw)) return Effect.succeed(pairs)
  return Effect.try({
    try: () => JSON.parse(raw.value) as unknown,
    catch: () => malformedJson("--data")
  }).pipe(
    Effect.map((decoded) =>
      decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
        ? { ...pairs, ...(decoded as Record<string, unknown>) }
        : { ...pairs, data: decoded }
    )
  )
}

const approval = (serialized: string): Effect.Effect<ControlService.ApprovalInput, CliError.UsageError> =>
  decodeJson(
    "approval",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.ApprovalPayload, { reportInput: false })
  )

const signal = (serialized: string): Effect.Effect<ControlSchema.SignalPayload, CliError.UsageError> =>
  decodeJson(
    "signal-json",
    serialized,
    Schema.decodeUnknownEffect(ControlSchema.SignalPayload, { reportInput: false })
  )

const render = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* rootCommand
    const rendered = yield* output.render(value, root.json ? "json" : "human")
    yield* Console.log(rendered.text)
  })

/** Forces JSON rendering, for the `events` alias and the `--json` contract. */
const renderJson = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const rendered = yield* output.render(value, "json")
    yield* Console.log(rendered.text)
  })

/**
 * A local CLI owns the executor layer. Keep that scope alive after accepting
 * a run so its driver is not interrupted as soon as the receipt is printed.
 * A settlement is any event that leaves this process nothing to drive: a park
 * for approval, a `pending` launch the executor declined, or a terminal
 * status.
 */
const settled = (kind: string): boolean =>
  kind === "control.run.waiting-approval" ||
  kind === "control.run.pending" ||
  kind === "control.run.completed" ||
  kind === "control.run.failed" ||
  kind === "control.run.cancelled"

const watchFailure = (
  error: unknown,
  runId: string,
  operation: string
): ControlError.TransportError =>
  new ControlError.TransportError({
    message: `Control watch failed during ${operation} for run ${JSON.stringify(runId)}. Retry the command.`,
    retryable: error instanceof ControlError.TransportError ? error.retryable : true,
    cause: error
  })

/**
 * Waits for the run to settle and reports the event kind that settled it, or
 * `undefined` when nothing was waited for.
 */
interface Settlement {
  readonly kind: string
  readonly cause?: string
}

const awaitRun = (
  control: ControlService.Service,
  runId: string,
  afterSequence: number | undefined
): Effect.Effect<Settlement | undefined, ControlError.TransportError, Command.CommandContext<"smthrs">> =>
  Effect.gen(function*() {
    const globals = yield* rootCommand
    return yield* RunProgress.observe(
      control.watch(afterSequence === undefined ? { runId } : { runId, afterSequence }),
      runId,
      globals.silent || globals.quiet
    ).pipe(
      Stream.filter((event) => settled(event.kind)),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((events): Settlement | undefined => {
        const event = globalThis.Array.from(events)[0]
        if (event === undefined) return undefined
        const payload = event.payload
        const cause = typeof payload === "object" && payload !== null && "cause" in payload ? payload.cause : undefined
        return { kind: event.kind, ...(typeof cause === "string" ? { cause } : {}) }
      }),
      Effect.mapError((error) => watchFailure(error, runId, "settlement"))
    )
  })

/**
 * Finds the greatest sequence in a stream without retaining its history.
 *
 * Use this for journal cursors whose histories can exceed the JavaScript
 * argument limit. Stream failures are preserved so a caller never substitutes
 * a weaker cursor after a failed read.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const latestSequence = <E, R>(
  events: Stream.Stream<{ readonly sequence: number }, E, R>
): Effect.Effect<number | undefined, E, R> =>
  Stream.runFold(
    events,
    () => undefined as number | undefined,
    (latest, event) => latest === undefined || event.sequence > latest ? event.sequence : latest
  )

/**
 * The sequence of the latest committed `control.run.waiting-approval` event:
 * the park a resume applies to. It keys the resume mutation, so resuming a
 * second park is a fresh mutation instead of a replay of the first resume's
 * recorded receipt, and it scopes the settlement wait.
 */
const latestPark = (control: ControlService.Service, runId: string) =>
  latestSequence(
    control.watch({ runId, follow: false }).pipe(
      Stream.filter((event) => event.kind === "control.run.waiting-approval")
    )
  ).pipe(
    // A failed park lookup cannot safely mint the run-only resume key. Keep it
    // in the error channel so no mutation is attempted with a weaker key.
    Effect.mapError((error) => watchFailure(error, runId, "approval-park lookup"))
  )

const awaitOwnedRun = (
  control: ControlService.Service,
  receipt: ControlSchema.Receipt,
  afterSequence: number | undefined
): Effect.Effect<Settlement | undefined, ControlError.TransportError, Command.CommandContext<"smthrs">> =>
  Effect.gen(function*() {
    // A run that had already settled when the verb reached it has no
    // settlement event left to wait for, and the receipt carries the answer.
    // Without this, `smthrs run --resume <run-id>` against a run that
    // settled `failed` printed `{"_tag":"Terminal","status":"failed"}` and
    // exited 0, because every receipt tag but `Accepted` reported nothing at
    // all (recorded by the cli-exit-code lane's verifier).
    if (receipt._tag === "Terminal") return { kind: `control.run.${receipt.status}` }
    const ownsExecutor = yield* ExecutorOwnership.ExecutorOwnership
    if (!ownsExecutor || receipt._tag !== "Accepted" || receipt.runId === undefined) return undefined
    return yield* awaitRun(control, receipt.runId, afterSequence)
  })

/**
 * The park a decision answers, or nothing for a plan-level decision.
 *
 * `Control.approve` and `Control.deny` restart the run their `ask` parked, in
 * the deciding call. The driver that picks that
 * resume up is this process's own executor, so a command that printed its
 * receipt and returned took the driver down with it and left the run it had
 * just restarted exactly where it stood, still needing `run --resume`, which
 * is the second call the contract says a decision replaces.
 *
 * A plan-level decision has no run yet, and the settlement wait needs one.
 */
const decisionPark = (
  control: ControlService.Service,
  target: ControlSchema.ApprovalTarget
) => target._tag === "Node" ? latestPark(control, target.runId) : Effect.succeed(undefined)

/**
 * Renders what the control plane knows about a declined launch, and returns
 * the refusal the verb exits with.
 *
 * `control.run.pending` is the executor saying it will not take the run: no
 * seat resolved, a capability was not granted, or the host refused it. The run
 * row is durable and stays at `accepted` with nothing driving it. Printing the
 * launch receipt there said `Accepted` and exited 0, which is the one answer
 * that is wrong in both halves.
 */
const declinedLaunch = (control: ControlService.Service, runId: string) =>
  Effect.gen(function*() {
    const summary = yield* summaryOf(control, runId)
    if (summary !== undefined) yield* render(summary)
    return new CliError.UnsupportedError({
      message: `Run ${runId} was accepted but no executor took it: it is ` +
        `${summary?.status ?? "accepted"} with nothing running. This host drives prompt flows. A flow whose ` +
        `body is a module (\`flow.ts\`) is driven by the host program that registers its delegates, and a flow ` +
        `this project's registry does not hold belongs to another host: run the flow from that program, or end ` +
        `the run with \`smthrs cancel ${runId}\`. \`smthrs status ${runId}\` shows what it waits for.`
    })
  })

/** Whether the settlement this process waited for was the executor declining. */
const wasDeclined = (settlement: Settlement | undefined): boolean => settlement?.kind === "control.run.pending"

/**
 * The process status one settlement reports, or nothing when the settlement
 * says nothing about how the run ended.
 *
 * The `up` command promises that an
 * attached launch exits with the terminal status code. The launch contract
 * paragraph is the vocabulary that code is spelled in: 0 success, 1 error, 2
 * usage, 3 parked, 130 SIGINT, 143 SIGTERM. A cancel reports the interrupt
 * status because a cancel is an interruption: `Control.cancel` settles the run
 * through `ControlRuntime.interrupt`, and reporting it separately keeps a
 * cancelled run distinguishable from a failed one.
 *
 * Until this existed, `runLaunch` failed only on `control.run.pending`, so a
 * `control.run.failed` settlement rendered the launch receipt and exited 0.
 * No caller of `smthrs up` could read a red run from the exit code: the
 * release validation measured `smthrs up ci-fast --json` returning 0 in
 * three seconds while `smthrs ps` reported `failed`.
 */
const settlementStatus = (settlement: Settlement | undefined): number | undefined => {
  switch (settlement?.kind) {
    case "control.run.completed":
      return 0
    case "control.run.failed":
      return 1
    case "control.run.cancelled":
      return 130
    case "control.run.waiting-approval":
      return 3
    default:
      return undefined
  }
}

/**
 * Reports a settled run's terminal status as this process's exit status.
 *
 * Written after the receipt is rendered, never instead of it: the `--json`
 * contract is that an attached launch prints its receipt, and a caller reads
 * `runId` from that document whatever the run then did. `bin.ts` hands a
 * successful exit whatever `process.exitCode` holds, which is how
 * `smthrs migrate` reports its own status too.
 */
const reportSettlement = (settlement: Settlement | undefined) =>
  Effect.suspend(() => {
    const status = settlementStatus(settlement)
    return status === undefined ? Effect.void : CommandStatus.set(status)
  })

/** Admission stays identifiable while an attached failure states its verdict. */
const renderReceipt = (receipt: ControlSchema.Receipt, settlement: Settlement | undefined) =>
  render(
    settlement?.kind === "control.run.failed"
      ? {
        ...receipt,
        status: "failed",
        cause: settlement.cause === undefined ? "no cause recorded in the journal" : causeLine(settlement.cause)
      }
      : receipt
  )

/** Every event of one run, oldest first. */
const eventsOf = (control: ControlService.Service, runId: string) =>
  History.collect(control.watch({ runId, follow: false }), {
    operation: "event-history read",
    subject: `run ${JSON.stringify(runId)}`
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CliError.ResourceLimitError ? error : watchFailure(error, runId, "event-history read")
    )
  )

/** One run's summary, or undefined when the control plane has no such run. */
const summaryOf = (control: ControlService.Service, runId: string) =>
  Effect.map(
    control.list({ _tag: "runs", filters: { runId } }),
    (listed) => listed._tag === "runs" ? listed.items.find((item) => item.runId === runId) : undefined
  )

const missingRun = (runId: string): CliError.UsageError =>
  new CliError.UsageError({ message: `Run not found: ${JSON.stringify(runId)}` })

/** One run's summary, failing before a reader projects an empty history. */
const requireRun = (control: ControlService.Service, runId: string) =>
  summaryOf(control, runId).pipe(
    Effect.flatMap((run) => run === undefined ? Effect.fail(missingRun(runId)) : Effect.succeed(run))
  )

// == the shipped-command contract verbs

const plan = Command.make(
  "plan",
  { flowId: requiredArgument("flow-id", true), input, data },
  (config) =>
    Effect.gen(function*() {
      yield* guardGlobals
      const decodedInput = yield* decodeInput(config.input, config.data)
      const flowId = yield* selectedFlow(config.flowId)
      if (Unsupported.isReservedFlow(flowId)) {
        return yield* Effect.fail(Unsupported.reservedFlowError("plan", flowId))
      }
      const control = yield* ControlService.Control
      yield* render(yield* control.plan({ flowId, input: decodedInput }))
    })
).pipe(Command.withDescription(Verb.find("plan")!.help))

const runResume = (planOrRunId: string) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const parkSequence = yield* latestPark(control, planOrRunId)
    const receipt = yield* control.resume({
      runId: planOrRunId,
      idempotencyKey: parkSequence === undefined
        ? `cli:resume:${planOrRunId}`
        : `cli:resume:${planOrRunId}:${parkSequence}`
    })
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    if (wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* renderReceipt(receipt, settlement)
    return yield* reportSettlement(settlement)
  })

/**
 * Announces a detached run's admission to its own log, as soon as the run row
 * is durable. The launcher in the parent process waits for exactly this line.
 */
const announceAdmission = (receipt: ControlSchema.Receipt) =>
  Effect.sync(() => {
    const nonce = process.env[Detached.admissionVariable]
    if (nonce === undefined || nonce === "") return
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return
    process.stderr.write(`${Detached.admissionLine(nonce, receipt.runId)}\n`)
  })

const runLaunch = (payload: ControlService.ApprovalInput) =>
  Effect.gen(function*() {
    const target = payload.target
    if (target._tag !== "Plan") {
      return yield* Effect.fail(new CliError.UsageError({ message: "run requires a plan approval payload" }))
    }
    const control = yield* ControlService.Control
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: target.planId,
      digest: target.digest,
      envelope: target.envelope,
      idempotencyKey: payload.idempotencyKey
    })
    yield* announceAdmission(receipt)
    const settlement = yield* awaitOwnedRun(control, receipt, undefined)
    if (wasDeclined(settlement) && receipt._tag === "Accepted" && receipt.runId !== undefined) {
      return yield* Effect.fail(yield* declinedLaunch(control, receipt.runId))
    }
    yield* renderReceipt(receipt, settlement)
    yield* reportSettlement(settlement)
  })

const run = Command.make("run", {
  plan: requiredArgument("plan-payload"),
  resume: Flag.boolean("resume").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Resume the parked run named by the positional argument")
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    if (config.resume) return yield* runResume(config.plan)
    yield* runLaunch(yield* approval(config.plan))
  })).pipe(Command.withDescription(Verb.find("run")!.help))

const resume = Command.make("resume", { runId: requiredArgument("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* runResume(config.runId)
  })).pipe(Command.withDescription("Alias of `run --resume`"), Command.unlisted)

const upFlags = {
  flow: requiredArgument("flow", true),
  data,
  detached: Flag.boolean("detached").pipe(
    Flag.withDefault(false),
    Flag.withAlias("d"),
    Flag.withDescription("Launch a local executor in the background and print its run id and log path")
  ),
  serve: removedFlag("up", "serve"),
  interactive: removedFlag("up", "interactive"),
  supervise: removedFlag("up", "supervise"),
  herdr: removedFlag("up", "herdr"),
  monitor: removedFlag("up", "monitor"),
  report: removedFlag("up", "report"),
  force: removedFlag("up", "force"),
  "steal-ownership": removedFlag("up", "steal-ownership"),
  "resume-claim-owner": removedFlag("up", "resume-claim-owner"),
  "resume-claim-heartbeat": removedFlag("up", "resume-claim-heartbeat"),
  "resume-restore-owner": removedFlag("up", "resume-restore-owner"),
  "resume-restore-heartbeat": removedFlag("up", "resume-restore-heartbeat"),
  "max-concurrency": removedValueFlag("max-concurrency")
}

const up = Command.make("up", upFlags, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("up", {
      serve: config.serve,
      interactive: config.interactive,
      supervise: config.supervise,
      herdr: config.herdr,
      monitor: config.monitor,
      report: config.report,
      force: config.force,
      "steal-ownership": config["steal-ownership"],
      "resume-claim-owner": config["resume-claim-owner"],
      "resume-claim-heartbeat": config["resume-claim-heartbeat"],
      "resume-restore-owner": config["resume-restore-owner"],
      "resume-restore-heartbeat": config["resume-restore-heartbeat"],
      "max-concurrency": config["max-concurrency"]
    })
    const globals = yield* rootCommand
    const remote = Option.getOrUndefined(globals.remote) ?? Environment.read(process.env, "SMITHERS_REMOTE")
    if (config.detached && remote !== undefined) {
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: "up -d spawns a local executor; run `smthrs up` attached against --remote"
        })
      )
    }
    const flowId = yield* selectedFlow(config.flow)
    if (Unsupported.isReservedFlow(flowId)) {
      return yield* Effect.fail(Unsupported.reservedFlowError("up", flowId))
    }
    const decodedInput = yield* decodeInput([], config.data)
    const control = yield* ControlService.Control
    const card = yield* control.plan({ flowId, input: decodedInput })
    // Scope `run`: the approval authorizes this launch and its whole run, not
    // every future launch of the flow.
    yield* control.approve({ ...card.approval, scope: "run" })
    if (!config.detached) return yield* runLaunch({ ...card.approval, scope: "run" })

    const projectRoot = yield* Project.ProjectRoot
    const timeoutMs = Environment.readInteger(process.env, "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    const passthrough = [
      // The child runs with the project root as its cwd. An absolute MCP path
      // preserves the file the parent parsed when the flag was relative.
      ...(Option.isNone(globals.mcpConfig)
        ? []
        : ["--mcp-config", resolve(process.cwd(), globals.mcpConfig.value)]),
      ...(Option.isNone(globals.root) ? [] : ["--root", projectRoot])
    ]
    const launched = yield* Effect.callback<Detached.Launched | Detached.Rejected>((resume, signal) => {
      const pending = Detached.launch({
        root: projectRoot,
        payload: JSON.stringify({ ...card.approval, scope: "run" }),
        passthrough,
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
      pending.then((result) => resume(Effect.succeed(result)), (error) => resume(Effect.die(error)))
      // Interruption aborts the signal first. Wait for termination and reaping
      // before the CLI scope can close and the process can exit.
      return Effect.promise(() => pending.then(() => undefined, () => undefined))
    })
    if (!Detached.isLaunched(launched)) {
      return yield* Effect.fail(
        new CliError.UnsupportedError({
          message: `${launched.reason}\nLog: ${launched.logFile}${launched.tail === "" ? "" : `\n${launched.tail}`}`
        })
      )
    }
    // The receipt's own field, never an operator-supplied id: rc.0 has no
    // `--run-id`, and a caller reads the run id from here.
    yield* render({ runId: launched.runId, logFile: launched.logFile, detached: true })
  })).pipe(Command.withDescription(Verb.find("up")!.help))

const approve = Command.make("approve", {
  approval: requiredArgument("approval"),
  // The interactive CLI is an operator affirming the whole launch, matching
  // `up`. MCP defaults to `once` because an omitted tool argument must not
  // widen a client's capabilities for the rest of the run.
  scope: Flag.choice("scope", ["once", "run", "remembered"] as const).pipe(
    Flag.withDefault(defaultApprovalScope),
    Flag.withDescription(
      "How far the grant reaches: this ask only, the whole run (the default, matching `up`), or every later run. " +
        "The MCP resolve_approval tool defaults to `once` instead, because an argument a client never sent must " +
        "not widen what it may do"
    )
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* decisionPark(control, payload.target)
    const receipt = yield* control.approve({ ...payload, scope: config.scope })
    // A decision restarts the run it answers, in this call, on this process's
    // own executor. The decision therefore ends with
    // a settled run, and the shell that ran `smthrs approve` is entitled to
    // read that run's status from `$?` exactly as `up` and `run` promise it.
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* renderReceipt(receipt, settlement)
    yield* reportSettlement(settlement)
  })).pipe(Command.withDescription(Verb.find("approve")!.help))

const deny = Command.make("deny", { approval: requiredArgument("approval") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* approval(config.approval)
    const control = yield* ControlService.Control
    const parkSequence = yield* decisionPark(control, payload.target)
    const receipt = yield* control.deny(payload)
    const settlement = yield* awaitOwnedRun(control, receipt, parkSequence)
    yield* renderReceipt(receipt, settlement)
    yield* reportSettlement(settlement)
  })).pipe(Command.withDescription(Verb.find("deny")!.help))

const cancel = Command.make("cancel", { runId: requiredArgument("run-id") }, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* render(yield* control.cancel({ runId: config.runId, idempotencyKey: `cli:cancel:${config.runId}` }))
  })).pipe(Command.withDescription(Verb.find("cancel")!.help))

/**
 * The idempotency key of one signal delivery.
 *
 * The payload digest is part of the key because two different signals to one
 * run are two mutations. At the import reference the key was `cli:signal:<id>`
 * alone, so the second signal replayed the first one's recorded receipt and
 * was never delivered.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signalKey = (runId: string, payload: ControlSchema.SignalPayload): string => {
  const encoded = Schema.encodeSync(ControlSchema.SignalPayload)(payload)
  const canonical = Schema.decodeUnknownSync(Canonical.Canonical)(encoded)
  return `cli:signal:${runId}:${Sha256.digestSync(canonical)}`
}

const signalCommand = Command.make("signal", {
  runId: requiredArgument("run-id"),
  payload: requiredArgument("signal-json")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const payload = yield* signal(config.payload)
    const control = yield* ControlService.Control
    yield* render(
      yield* control.signal({
        runId: config.runId,
        signal: payload,
        idempotencyKey: signalKey(config.runId, payload)
      })
    )
  })).pipe(Command.withDescription(Verb.find("signal")!.help))

const steer = Command.make("steer", {
  runId: requiredArgument("run-id"),
  message: Flag.string("message").pipe(
    Flag.withDescription("Text to deliver as an attributed steering message to the run"),
    Flag.withFallbackPrompt(inputPrompt("--message"))
  ),
  takeover: removedFlag("steer", "takeover")
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    yield* refuseRemoved("steer", { takeover: config.takeover })
    const control = yield* ControlService.Control
    const stamp = Date.now()
    const messageId = `cli:steer:${config.runId}:${randomUUID()}`
    yield* render(
      yield* control.steer({
        runId: config.runId,
        message: {
          kind: "Message",
          messageId,
          runId: config.runId,
          principal: { kind: "operator", id: "cli", stampedAt: stamp },
          createdAt: stamp,
          body: config.message
        },
        idempotencyKey: messageId
      })
    )
  })).pipe(Command.withDescription(Verb.find("steer")!.help))

const flowCatalog = FlowCatalog.read

const listFlows = Effect.gen(function*() {
  yield* guardGlobals
  const control = yield* ControlService.Control
  const catalog = yield* flowCatalog(control)
  // The reserved catalog is the control plane's projection surface, not this
  // project's flows. Listing it invited `up system/release`, which planned,
  // launched, and then sat at `accepted` with nothing to run. Discovery
  // warnings belong to `doctor`, so the stable `ls` document remains a plain
  // flow page even though both commands read the same paged catalog.
  // The featured set and the one-line summaries come from the project's
  // generated .smithers/factory.json when it is checked in; a project without
  // one lists exactly the discovered page. A person at a terminal reads one line
  // per flow with the featured rows starred; `--json` keeps the document.
  const projectRoot = yield* Project.ProjectRoot
  const items = FeaturedFlows.present(
    catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId)),
    FeaturedFlows.read(projectRoot)
  )
  const root = yield* rootCommand
  yield* render(root.json ? { _tag: "flows", items } : FeaturedFlows.human(items).replace(/\n$/, ""))
})

const ls = Command.make("ls", {}, () => listFlows).pipe(Command.withDescription(Verb.find("ls")!.help))

const workflowList = Command.make("list", {}, () => listFlows).pipe(
  Command.withDescription("Alias of `ls`"),
  Command.unlisted
)

const workflow = Command.make(
  "workflow",
  { rest: Argument.string("subcommand").pipe(Argument.variadic()) },
  (config) => Effect.fail(Unsupported.verbError(removedVerb("workflow"), config.rest[0]))
).pipe(
  Command.withDescription("Removed; only `workflow list` survives, as an alias of `ls`"),
  Command.unlisted,
  Command.withSubcommands([workflowList])
)

const ps = Command.make("ps", {
  flow: Flag.string("flow").pipe(
    Flag.optional,
    Flag.withDescription("Only list runs of this flow id")
  ),
  // Validated, not cast: at the import reference any string reached the store
  // as a `RunStatus`, so `--status done` listed nothing and said nothing.
  status: Flag.choice(
    "status",
    [
      "accepted",
      "running",
      "parked",
      "waiting-approval",
      "cancelled",
      "completed",
      "failed"
    ] as const
  ).pipe(Flag.optional, Flag.withDescription("Only list runs with this lifecycle status"))
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const now = yield* Clock.currentTimeMillis
    yield* render(
      yield* labelled(
        yield* control.list({
          _tag: "runs",
          filters: {
            ...(Option.isNone(config.flow) ? {} : { flowId: config.flow.value }),
            ...(Option.isNone(config.status) ? {} : { status: config.status.value })
          }
        }),
        now
      )
    )
  })).pipe(Command.withDescription(Verb.find("ps")!.help))

/**
 * The window a driven launch may sit at `accepted` before it claims the run.
 *
 * An ordinary driven launch commits an accepted summary before its executor
 * begins work, so the listing waits out this handoff before probing the owner.
 */
const executorHandoffWindowMillis = 5_000

/**
 * Whether a listing should say a run is waiting for an executor.
 *
 * This is a rendering heuristic over the listing's own fields, not a durable
 * verdict: the durable one is the `control.run.pending` event the status card
 * reads from the run's journal. For a same-host owner it uses the same
 * fail-closed PID probe as run recovery. A foreign-host owner cannot be
 * inspected and is never declared absent here.
 */
const statusObserver: Ownership.OwnerId = Object.freeze({
  hostId: hostname(),
  pid: process.pid,
  nonce: "cli-status-observer"
})

const unclaimed = (run: ControlSchema.RunSummary, now: number): Effect.Effect<boolean> => {
  if (run.status !== "accepted" || run.waitingReason !== undefined) return Effect.succeed(false)
  if (now - run.updatedAt < executorHandoffWindowMillis) return Effect.succeed(false)
  if (run.ownerId === undefined) return Effect.succeed(true)
  try {
    const owner = Schema.decodeUnknownSync(Ownership.OwnerId)(JSON.parse(run.ownerId))
    if (owner.hostId !== statusObserver.hostId) return Effect.succeed(false)
    return Ownership.sameHostPidProbe(owner, {
      claimant: statusObserver,
      heartbeatAtMs: null,
      nowMs: now
    }).pipe(Effect.map((alive) => !alive))
  } catch {
    return Effect.succeed(false)
  }
}

/**
 * Names what an unclaimed run waits for, in the field that already carries it.
 *
 * `RunSummary.waitingReason` is "what a parked run is holding on". This one
 * holds on an executor, and before the label a listing showed it as an
 * ordinary `accepted` run, indistinguishable from one a live peer owns.
 */
const labelled = (listed: ControlSchema.ListResponse, now: number): Effect.Effect<ControlSchema.ListResponse> =>
  listed._tag === "runs"
    ? Effect.map(
      Effect.forEach(
        listed.items,
        (run) => Effect.map(unclaimed(run, now), (missing) => missing ? { ...run, waitingReason: "executor" } : run)
      ),
      (items) => ({ ...listed, items })
    )
    : Effect.succeed(listed)

const statusOf = (runId: Option.Option<string>) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const filters = Option.isSome(runId) ? { runId: runId.value } : undefined
    const listed = yield* labelled(yield* control.list({ _tag: "runs", filters }), yield* Clock.currentTimeMillis)
    const root = yield* rootCommand
    // `--json` keeps the stable listing shape untouched; a human reader with a
    // run id gets the diagnosis card computed from that run's own events.
    if (Option.isNone(runId)) return yield* render(listed)
    const run = listed._tag === "runs" ? listed.items.find((item) => item.runId === runId.value) : undefined
    if (run === undefined) return yield* Effect.fail(missingRun(runId.value))
    if (root.json) return yield* render(listed)
    const events = yield* eventsOf(control, runId.value)
    yield* render(Forensics.renderDiagnosis(run, Forensics.digest(events)))
  })

const status = Command.make("status", {
  runId: Argument.string("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(
  Command.withDescription(Verb.find("status")!.help),
  Command.withAlias("inspect")
)

const why = Command.make("why", {
  runId: Argument.string("run-id").pipe(Argument.optional)
}, (config) => statusOf(config.runId)).pipe(Command.withDescription("Alias of `status`"), Command.unlisted)

const readLogs = (runId: Option.Option<string>, follow: boolean, forceJson: boolean) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const root = yield* rootCommand
    const json = forceJson || root.json
    if (Option.isSome(runId)) yield* requireRun(control, runId.value)
    const watchedRunId = Option.getOrElse(runId, () => "*")
    const events = control.watch({
      runId: Option.getOrUndefined(runId),
      follow
    }).pipe(
      Stream.mapError((error) => watchFailure(error, watchedRunId, follow ? "log follow" : "event-history read"))
    )
    // Human output is the transcript projection; `--json` remains the raw
    // event stream, byte-stable for scripts. Follow mode renders one line per
    // event as it lands, because a transcript needs the whole run.
    if (follow) {
      return yield* Stream.runForEach(
        events,
        (event) =>
          Effect.gen(function*() {
            if (History.encodedBytes(event) > History.maximumEventBytes) {
              return yield* Effect.fail(
                new CliError.ResourceLimitError({
                  operation: "log follow",
                  subject: `run ${JSON.stringify(watchedRunId)}`,
                  limit: History.maximumEventBytes,
                  unit: "bytes"
                })
              )
            }
            yield* (json ? renderJson(event) : render(Forensics.eventLine(event)))
          })
      )
    }
    const collected = yield* History.collect(events, {
      operation: "event-history read",
      subject: `run ${JSON.stringify(watchedRunId)}`
    })
    if (json) return yield* renderJson(collected)
    yield* render(Forensics.renderTranscript(collected))
  })

const logs = Command.make("logs", {
  runId: Argument.string("run-id").pipe(Argument.optional),
  follow: Flag.boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Keep streaming new run events after the recorded history")
  )
}, (config) => readLogs(config.runId, config.follow, false)).pipe(
  Command.withDescription(Verb.find("logs")!.help)
)

const events = Command.make("events", {
  runId: Argument.string("run-id").pipe(Argument.optional),
  follow: Flag.boolean("follow").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Keep streaming new run events after the recorded history")
  )
}, (config) => readLogs(config.runId, config.follow, true)).pipe(
  Command.withDescription("Alias of `logs --json`"),
  Command.unlisted
)

const output = Command.make("output", {
  runId: requiredArgument("run-id"),
  nodeId: Argument.string("node-id").pipe(Argument.optional)
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* requireRun(control, config.runId)
    const collected = yield* eventsOf(control, config.runId)
    const nodes = NodeOutput.project(collected)
    const requested = Option.getOrUndefined(config.nodeId)
    if (requested === undefined) return yield* render(renderValue(nodes))
    const node = nodes.find((candidate) => candidate.nodeId === requested)
    if (node === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({ message: NodeOutput.notFound(config.runId, requested, nodes) })
      )
    }
    const root = yield* rootCommand
    yield* render(renderValue(root.json ? node : NodeOutput.render(node)))
  })).pipe(Command.withDescription(Verb.find("output")!.help))

const down = Command.make("down", {}, () =>
  Effect.gen(function*() {
    yield* guardGlobals
    // The unified bridge imports this command tree; load its helper only once
    // the legacy handler runs so the two command surfaces can initialize.
    const { cancelAll } = yield* Effect.promise(() => import("./cli/ControlCommands.ts"))
    yield* render(yield* cancelAll())
  })).pipe(Command.withDescription(Verb.find("down")!.help))

/**
 * The migration tool's own flag set, declared on the verb.
 *
 * `smthrs migrate` and `smithers-migrate` run the same entry, so they take
 * the same options. A verb that declared none of them could only ever plan:
 * `--apply` converts the project source,
 * and an operator who cannot type it has no way to reach the transformation.
 * `--json` is not repeated here because it is already a shared global.
 */
const migrateFlags = {
  scan: Flag.boolean("scan").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Inventory the project and write the report without planning any unit")
  ),
  apply: Flag.boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Convert the project source, instead of planning the conversion")
  ),
  seat: Flag.string("seat").pipe(
    Flag.withDescription("The model seat the migration's agent runs on"),
    Flag.optional
  ),
  allowUnsafe: Flag.string("allow-unsafe").pipe(
    Flag.withDescription("Accept the named unsafe constructs, or `all`"),
    Flag.optional
  ),
  acknowledgeRunState: Flag.boolean("acknowledge-run-state").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Accept the 0.x run state the report lists and migrate the source anyway")
  ),
  allowNoVcs: Flag.boolean("allow-no-vcs").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Accept a file copy as the only checkpoint, in a project under no version control")
  ),
  keepOldSources: Flag.boolean("keep-old-sources").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Leave the 0.x sources in place beside the flows written from them")
  ),
  unit: Flag.string("unit").pipe(
    Flag.withDescription("Migrate only these units, comma separated"),
    Flag.optional
  ),
  maxRepairRounds: Flag.integer("max-repair-rounds").pipe(
    Flag.withDescription("How many times one unit may be repaired before it is reported as failed"),
    Flag.optional
  ),
  reportDir: Flag.string("report-dir").pipe(
    Flag.withDescription("Where the report is written, relative to the project root"),
    Flag.optional
  ),
  flowsDir: Flag.string("flows-dir").pipe(
    Flag.withDescription("Where the written flows go, instead of `flows/`"),
    Flag.optional
  ),
  verifyInstall: Flag.string("verify-install").pipe(
    Flag.withDescription("The command that installs dependencies, instead of the one the lockfile implies"),
    Flag.optional
  ),
  verifyFormat: Flag.string("verify-format").pipe(
    Flag.withDescription("The command that formats the project, instead of the one its config implies"),
    Flag.optional
  ),
  verifyTypecheck: Flag.string("verify-typecheck").pipe(
    Flag.withDescription(
      "The command that typechecks the project, repeatable; one empty value runs no typecheck at all"
    ),
    Flag.atLeast(0)
  ),
  verifyTest: Flag.string("verify-test").pipe(
    Flag.withDescription("The command that runs the tests, instead of the project's own test script"),
    Flag.optional
  )
}

const migrate = Command.make("migrate", {
  path: Argument.string("path").pipe(Argument.optional),
  to: removedValueFlag("to"),
  ...migrateFlags
}, (config) =>
  Effect.gen(function*() {
    yield* refuseRemoved("migrate", { to: config.to })
    const migrationRoot = yield* Project.MigrationRoot
    const target = Option.getOrElse(config.path, () => migrationRoot)
    const root = yield* rootCommand
    const outcome = yield* MigrateCmd.run({
      target,
      scan: config.scan,
      apply: config.apply,
      seat: Option.getOrUndefined(config.seat),
      allowUnsafe: Option.getOrUndefined(config.allowUnsafe),
      acknowledgeRunState: config.acknowledgeRunState,
      allowNoVcs: config.allowNoVcs,
      keepOldSources: config.keepOldSources,
      unit: Option.getOrUndefined(config.unit),
      maxRepairRounds: Option.getOrUndefined(config.maxRepairRounds),
      reportDir: Option.getOrUndefined(config.reportDir),
      flowsDir: Option.getOrUndefined(config.flowsDir),
      verifyInstall: Option.getOrUndefined(config.verifyInstall),
      verifyFormat: Option.getOrUndefined(config.verifyFormat),
      verifyTypecheck: config.verifyTypecheck,
      verifyTest: Option.getOrUndefined(config.verifyTest)
    }, yield* globalsOf)
    if (outcome._tag === "Parked") {
      const { _tag: _, ...document } = outcome
      if (root.json) yield* Console.log(JSON.stringify(document))
      else {
        yield* Console.error(
          `smthrs migrate: ${outcome.message}${outcome.details === undefined ? "" : `\n${outcome.details}`}`
        )
      }
      return yield* CommandStatus.set(3)
    }
    yield* Console.log(MigrateCommand.render(outcome.report, root.json ? "json" : "human", outcome.reportDirectory))
    // The migration's own status, the way `smithers-migrate` reports it: 3 is
    // "parked, the operator has a decision", not a failure. `bin.ts` hands a
    // successful exit whatever `process.exitCode` holds, which is also how
    // `NodeControl.layerOutput` transfers a rendered status.
    yield* CommandStatus.set(MigrateCommand.exitCode(outcome.report))
  })).pipe(Command.withDescription(Verb.find("migrate")!.help))

const claudeSession = Flag.string("session").pipe(
  Flag.optional,
  Flag.withDescription("Claude Code session id; falls back to CLAUDE_CODE_SESSION_ID")
)

const sessionId = (raw: Option.Option<string>): string =>
  Option.getOrElse(raw, () => process.env["CLAUDE_CODE_SESSION_ID"] ?? "unknown")

const claudeTick = Command.make("tick", {
  runId: requiredArgument("run-id"),
  session: claudeSession,
  afterSeq: Flag.integer("after-seq").pipe(
    Flag.withDefault(0),
    Flag.withDescription("Only include events after this sequence number")
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    const projectRoot = yield* Project.ProjectRoot
    // Following a run is subscribing: every tick re-asserts the entry, so a
    // registry lost to a crash repairs itself on the next frame.
    yield* Effect.sync(() => ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session)))
    const collected = yield* eventsOf(control, config.runId)
    const run = yield* summaryOf(control, config.runId)
    const digest = Forensics.digest(collected)
    yield* renderJson(
      ClaudeMirror.frame(config.runId, run, collected, {
        afterSeq: config.afterSeq,
        parked: { question: digest.parkedQuestion, approval: digest.parkedApproval }
      })
    )
  })).pipe(Command.withDescription("Print one mirror frame for a run"))

const claudeNodeWait = Command.make("node-wait", {
  runId: requiredArgument("run-id"),
  nodeId: requiredArgument("node-id"),
  timeout: Flag.integer("timeout-ms").pipe(
    Flag.withDefault(30_000),
    Flag.withDescription("Maximum time in milliseconds to wait for the node to settle")
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const control = yield* ControlService.Control
    yield* requireRun(control, config.runId)
    const deadline = Date.now() + config.timeout
    const history = History.empty<ControlSchema.ControlEvent>()
    let afterSequence: number | undefined
    for (;;) {
      const previousLength = history.values.length
      yield* History.collectInto(
        control.watch({
          runId: config.runId,
          follow: false,
          ...(afterSequence === undefined ? {} : { afterSequence })
        }),
        history,
        { operation: "node wait", subject: `run ${JSON.stringify(config.runId)}` }
      ).pipe(
        Effect.mapError((error) =>
          error instanceof CliError.ResourceLimitError ? error : watchFailure(error, config.runId, "node wait")
        )
      )
      for (let index = previousLength; index < history.values.length; index++) {
        const event = history.values[index]!
        if (afterSequence === undefined || event.sequence > afterSequence) afterSequence = event.sequence
      }
      const node = NodeOutput.find(history.values, config.nodeId)
      if (node !== undefined && node.outcome !== "pending") return yield* renderJson({ ...node, timedOut: false })
      const run = yield* summaryOf(control, config.runId)
      if (run !== undefined && ClaudeMirror.isTerminal(run.status)) {
        return yield* renderJson({ nodeId: config.nodeId, outcome: "vanished", status: run.status, timedOut: false })
      }
      if (Date.now() >= deadline) {
        return yield* renderJson({ nodeId: config.nodeId, outcome: "pending", timedOut: true })
      }
      yield* Effect.sleep("250 millis")
    }
  })).pipe(Command.withDescription("Block until one node settles"))

const claudeMonitor = Command.make("monitor", {
  session: claudeSession,
  allRuns: Flag.boolean("all-runs").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Include all runs, beyond this session’s subscriptions")
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDefault(200),
    Flag.withDescription("Maximum number of runs in the monitor frame")
  )
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    if (!Number.isSafeInteger(config.limit) || config.limit <= 0) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: `--limit must be a positive integer; got ${JSON.stringify(String(config.limit))}`
        })
      )
    }
    const control = yield* ControlService.Control
    const projectRoot = yield* Project.ProjectRoot
    const followed = config.allRuns
      ? undefined
      : new Set(
        ClaudeMirror.readSubscriptions(projectRoot)
          .filter((entry) => entry.sessionId === sessionId(config.session))
          .map((entry) => entry.runId)
      )
    type Transition = NonNullable<ReturnType<typeof ClaudeMirror.transition>>
    const ring = yield* Stream.runFold(
      control.watch({ follow: false }),
      () => ({ values: [] as Array<Transition | undefined>, next: 0, count: 0 }),
      (state, event) => {
        const line = ClaudeMirror.transition(event)
        if (line === undefined || (followed !== undefined && !followed.has(line.runId))) return state
        state.values[state.next] = line
        state.next = (state.next + 1) % config.limit
        state.count = Math.min(config.limit, state.count + 1)
        return state
      }
    )
    for (let offset = 0; offset < ring.count; offset++) {
      const index = (ring.next - ring.count + offset + config.limit) % config.limit
      const line = ring.values[index]
      if (line !== undefined) yield* Console.log(JSON.stringify(line))
    }
  })).pipe(Command.withDescription("Print notable run transitions as NDJSON"))

const claudeSubscribe = Command.make("subscribe", {
  runId: requiredArgument("run-id"),
  session: claudeSession
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const entries = yield* Effect.sync(() =>
      ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session))
    )
    yield* renderJson({ subscriptions: entries.length })
  })).pipe(Command.withDescription("Follow a run in this session's mirror"))

const claudeUnsubscribe = Command.make("unsubscribe", {
  runId: requiredArgument("run-id"),
  session: claudeSession
}, (config) =>
  Effect.gen(function*() {
    yield* guardGlobals
    const projectRoot = yield* Project.ProjectRoot
    const entries = yield* Effect.sync(() =>
      ClaudeMirror.unsubscribe(projectRoot, config.runId, sessionId(config.session))
    )
    yield* renderJson({ subscriptions: entries.length })
  })).pipe(Command.withDescription("Stop following a run in this session's mirror"))

const claude = Command.make("claude").pipe(
  Command.withDescription(Verb.find("claude")!.help),
  Command.withSubcommands([claudeTick, claudeNodeWait, claudeMonitor, claudeSubscribe, claudeUnsubscribe])
)

const update = Command.make("update", {}, () =>
  Effect.gen(function*() {
    const status = yield* UpdateCmd.check(yield* globalsOf)
    yield* render(Update.render(status))
  })).pipe(Command.withDescription(Verb.find("update")!.help))

const bug = Command.make("bug", {
  summary: requiredArgument("summary"),
  rest: Argument.string("summary").pipe(Argument.variadic()),
  runId: Flag.string("run").pipe(Flag.optional, Flag.withDescription("Include only this run and its event digest")),
  yes: Flag.boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Post the previewed payload without an interactive confirmation")
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the exact redacted payload and endpoint without posting")
  )
}, (config) =>
  Effect.gen(function*() {
    const outcome = yield* BugCmd.submit({
      summary: [config.summary, ...config.rest].join(" "),
      runId: Option.getOrUndefined(config.runId),
      yes: config.yes,
      dryRun: config.dryRun,
      preview: (line) => Console.error(line)
    }, yield* globalsOf)
    yield* render(outcome)
  })).pipe(Command.withDescription(Verb.find("bug")!.help))

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function*() {
    const root = yield* rootCommand
    const report = yield* DoctorCmd.fromControl(yield* globalsOf)
    // `--json` prints the report verbatim. The human rendering goes through
    // `Ui`: clack symbols and a verdict line on a terminal, and on a pipe the
    // same one-line-per-check text `Doctor.render` has always produced.
    const ui = yield* Ui.current
    yield* render(
      root.json
        ? report
        : Ui.renderChecklist(`smthrs doctor: ${report.root}`, report.checks, { interactive: ui.interactive })
    )
    if (Doctor.failed(report)) {
      yield* Effect.fail(new CliError.UnsupportedError({ message: "doctor found a blocking problem" }))
    }
  })).pipe(Command.withDescription(Verb.find("doctor")!.help))

const gc = Command.make("gc", {
  olderThan: Flag.string("older-than").pipe(
    Flag.withDefault(Gc.defaultRetention),
    Flag.withDescription("Delete terminal runs older than this duration, for example 7d")
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Report the runs and rows that would be deleted without deleting them")
  ).pipe(Flag.withDefault(false))
}, (config) =>
  Effect.gen(function*() {
    const swept = yield* GcCmd.sweep({ olderThan: config.olderThan, dryRun: config.dryRun }, yield* globalsOf)
    yield* render(swept)
    if (swept.failures.length > 0) {
      return yield* Effect.fail(new CliError.UnsupportedError({ message: Gc.failureMessage(swept.failures) }))
    }
  })).pipe(Command.withDescription(Verb.find("gc")!.help))

// == the removed-command contract refusals

/**
 * Every removed verb, as a hidden subcommand that exits 1 with its reason.
 *
 * `workflows` is registered here under its own spelling like the rest. The
 * singular `workflow` is a separate command group, because `workflow list`
 * survives as the `ls` alias, and it refuses on its own with the same reason.
 */
const removedCommands = Unsupported.removedVerbs
  .filter((verb) => !ownGroupCommands.has(verb.name))
  .map((verb) =>
    Command.make(
      verb.name,
      { rest: Argument.string("argument").pipe(Argument.variadic()) },
      (config) => Effect.fail(Unsupported.verbError(verb, verb.subcommands === undefined ? undefined : config.rest[0]))
    ).pipe(
      Command.withDescription(`Removed in 1.0.0-rc.0: ${verb.reason}`),
      Command.unlisted
    )
  )

/**
 * The composed root command. Application composition supplies Control and
 * Output layers; this module contains no transport selection.
 *
 * Reach for this value from the executable or parser-level tests. Individual
 * handlers fail with the package's typed CLI errors, while a missing service
 * is left visible as a composition defect rather than hidden by the command
 * tree.
 *
 * @category constructors
 * @since 1.0.0
 */
export const cli = rootCommand.pipe(
  Command.withDescription("Plan, approve, and run durable flows"),
  Command.withSubcommands([
    plan,
    run,
    resume,
    up,
    approve,
    deny,
    cancel,
    signalCommand,
    steer,
    ls,
    workflow,
    ps,
    status,
    why,
    logs,
    events,
    output,
    down,
    doctor,
    gc,
    migrate,
    claude,
    update,
    bug,
    ...removedCommands
  ])
)
