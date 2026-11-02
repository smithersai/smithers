import { Logger } from "@smthrs/observability"
import { ContainerSession, ContainerTerminal, SandboxObject as SandboxHost } from "@smthrs/platform-cloudflare"
import type { SandboxTools } from "@smthrs/sandbox"
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Clock, Config, Effect, Fiber, Layer, Option, Schema, Scope } from "effect"
import { FetchHttpClient, HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as Database from "../db/Database.ts"
import { BranchSandbox } from "../infra/BranchSandbox.ts"
import { CiArtifacts, GateMachine } from "../infra/GateMachine.ts"
import { ROLES } from "../src/features/auth/contract.ts"
import { FORGE_HOST, SANDBOX_USER, WORKSPACE } from "../src/features/terminal/contract.ts"
import type { Role } from "./Actor.ts"
import { canEdit, canView, type Policy, underPolicy } from "./branch/Access.ts"
import { CHECKOUT_FAILURES, checkoutArgv, forgeRemote } from "./branch/Checkout.ts"
import * as Budget from "./branch/Budget.ts"
import * as Machine from "./branch/Machine.ts"
import * as Artifacts from "./branch/Artifacts.ts"
import * as JobMachines from "./branch/JobMachines.ts"
import {
  type CommandOutcome,
  type CommandRequest,
  type MachineObject,
  Machines,
  routed,
  type SleepOutcome,
  type ToolOutcome,
} from "./branch/Machines.ts"
import { userOf } from "./branch/Users.ts"
import { asUser, configuredSessionOn, failureFields, runOn, type UserOptions } from "./branch/Session.ts"
import { Forge, proxy } from "./branch/Forge.ts"
import {
  type Attachment,
  CheckoutFailed,
  type Revoked,
  SandboxBranch,
  Sandboxes,
  SandboxUnavailable,
  TerminalSockets,
} from "./branch/Sandboxes.ts"
import * as Agents from "./personal/Agents.ts"
import * as Subscriptions from "./personal/Subscriptions.ts"
import { SecretKeys } from "./secrets/Keys.ts"
import * as RegistryEgress from "./branch/RegistryEgress.ts"
import * as SandboxEgress from "./secrets/SandboxEgress.ts"
import * as Overflow from "./runners/Overflow.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as SocketChecks from "./SocketChecks.ts"

// Branch sandboxes on Cloudflare (decision 0013 §3, decision 0005 §2, docs/features/branch-workspace.md#the-machine):
// `SandboxObject`, one Durable Object per branch, named by the branch's id, owns that branch's container
// (infra/BranchSandbox.ts). It wakes the box, checks the branch out, starts terminal sessions, attaches sockets to them,
// and is the box's forge and egress: the container sends every request the box makes to ChatApi's own entrypoint
// (`ctx.exports.default` with `props` naming the object, Cloudflare's documented intercept target; a Durable Object's
// stub is not one, and in production a box's requests never reached it). ChatApi hands each back to the object
// (`answerBox`), which answers `http://forge.smithers.internal` with the read-only git proxy, adding the read credential
// the box never holds, and every other host as the box's egress: the package registries (worker/branch/RegistryEgress.ts),
// or with SANDBOX_SECRETS on, the secrets egress. ChatApi hosts it; the flows and
// routes reach it through `Sandboxes` and `TerminalSockets`, and the sandbox tools through `Machines`
// (docs/features/sandbox-tools.md), which this file provides from its namespace.
//
// A job machine the deployment declares (worker/branch/JobMachines.ts, docs/features/ci.md#machines) is the same object
// over its own container class and instance type, in its own namespace: `GateObject`, over the gate image
// (infra/GateMachine.ts). A branch names it in `SandboxBranch.machine`; its tools, its keep and its box's requests reach
// that namespace. A gate box also reaches its run's artifacts at `http://artifacts.smithers.internal`
// (worker/branch/Artifacts.ts), which its object answers from the `CiArtifacts` bucket.

/** The headers only ChatApi sets on a socket it hands the object; it strips any a browser sent (worker/branch/Terminals.ts). */
const TERMINAL_HEADER = "x-smithers-terminal"
const ACCESS_HEADER = "x-smithers-access"
const OWNER_HEADER = "x-smithers-owner"
const PRINCIPAL_HEADER = "x-smithers-principal"
const ROLE_HEADER = "x-smithers-role"
/**
 * The one-use ticket ChatApi takes from the object (`ticket`) for each socket it hands it. The box's own requests reach
 * the object's `fetch` too, for any host; only ChatApi, which holds the namespace, can get a ticket, so the box can never
 * attach to a terminal.
 */
const TICKET_HEADER = "x-smithers-ticket"

/**
 * `SANDBOX_SECRETS`: whether the box's outbound HTTP and HTTPS reach the secrets egress (worker/secrets/SandboxEgress.ts,
 * docs/features/secrets.md#the-egress), and the box gets its placeholders. Off unless set: it stays off until an e2e
 * proves a box gets a bound host's answer and never sees a value.
 */
export const sandboxSecrets = Config.Boolean("SANDBOX_SECRETS").pipe(Config.withDefault(false))

/**
 * `SANDBOX_INSTANCE`: the instance type a branch's machine starts on (decision 0013 §9), `standard-1` unless set: 1/2
 * vCPU, 4 GiB of memory and 8 GB of disk. Cloudflare's own default, `lite`, has 256 MiB, too little for a real
 * repository's clone and tests.
 */
export const sandboxInstance = Config.schema(JobMachines.Instance, "SANDBOX_INSTANCE").pipe(
  Config.withDefault("standard-1" as const),
)

/**
 * `SANDBOX_START_TIMEOUT_SECONDS`: the longest a stopped machine's container may take to start before its wake fails
 * `start_timeout`, 150 seconds unless set: a typed failure a call or a terminal settles on, where an unbounded start
 * (312 s seen) kept a call `running` until the browser gave up.
 */
export const sandboxStartTimeoutSeconds = Config.schema(
  Schema.Int.check(Schema.isGreaterThan(0)),
  "SANDBOX_START_TIMEOUT_SECONDS",
).pipe(Config.withDefault(150))


/**
 * `OVERFLOW_INSTANCE`: the instance type a repository's overflow box starts on (decision 0144), `standard-4` unless set:
 * 4 vCPU, 12 GiB and 20 GB, the largest, since it runs an agent and its builds.
 */
export const overflowInstance = Config.schema(
  Schema.Literals(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]),
  "OVERFLOW_INSTANCE",
).pipe(Config.withDefault("standard-4" as const))

/** Whether a wake failed because the container didn't finish starting in time (`SANDBOX_START_TIMEOUT_SECONDS`). */
const startTimedOut = (cause: Cause.Cause<unknown>) => Cause.squash(cause) instanceof SandboxHost.StartTimedOut

/** The step of a wake a failure happened in, as its `sandbox.wake` log line names it. */
type WakeStage = "admit" | "start" | "checkout" | "restore" | "placeholders" | "agent"

/** What a TODO's box keeps of its committer's subscription: no credential. */
interface BoxSubscription {
  readonly subscription: Subscriptions.Subscription
  /** What their commands run with: placeholders and switches. */
  readonly environment: Readonly<Record<string, string>>
  /** The machine's user whose commands get it. */
  readonly user: string
}

/** Whether `branch` is a TODO attempt's machine (worker/flows/TodoMachine.ts `machineId`). */
const isTodoBox = (branch: SandboxBranch) => branch.branchId.startsWith("todo-")

/** `NAME=value` lines as variables. */
const variablesOf = (environment: string): Record<string, string> =>
  Object.fromEntries(
    environment.split("\n").flatMap((line) => {
      const at = line.indexOf("=")
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : []
    }),
  )

/** A role as its header carries it: one of the roles, else none. */
const roleOf = (value: string | undefined): Role | null =>
  (ROLES as ReadonlyArray<string>).includes(value ?? "") ? (value as Role) : null

/**
 * The `ctx.props` key of ChatApi's own entrypoint that marks a request a branch's box sent, naming its object by id.
 * Only this Worker's own code can set `props` (`ctx.exports`); a request from anywhere else has none.
 */
export const BOX_PROP = "sandboxObject"

/** The `ctx.props` key naming the job machine whose namespace that object is in; absent for the default machine. */
export const MACHINE_PROP = "sandboxMachine"

/**
 * The object whose box sent the request with these `props`: its id and its machine (none for the default one); nothing
 * for any other request.
 */
export const boxOf = (props: unknown): { readonly id: string; readonly machine?: string } | undefined => {
  const fields = typeof props === "object" && props !== null ? (props as Record<string, unknown>) : {}
  const id = fields[BOX_PROP]
  const machine = fields[MACHINE_PROP]
  if (typeof id !== "string" || id === "") return undefined
  return typeof machine === "string" && machine !== "" ? { id, machine } : { id }
}

/** The loopback to ChatApi's own default entrypoint a Durable Object's `ctx.exports` holds, with `props`. */
interface Loopback {
  readonly exports: { readonly default: (options: { readonly props: Record<string, string> }) => Fetcher }
}

/**
 * What `wake` answers: the machine's generation, or why it couldn't wake: `Waiting` while the sandbox limits leave no
 * machine free (worker/branch/Budget.ts).
 */
export type Woken =
  | { readonly _tag: "Woken"; readonly generation: number }
  | { readonly _tag: "Unavailable"; readonly reason?: "start_timeout" }
  | { readonly _tag: "CheckoutFailed" }
  | { readonly _tag: "Waiting" }

/** The object's methods, as ChatApi and the flow host call them. */
export interface SandboxObjectShape {
  readonly wake: (branch: SandboxBranch, ownerId?: string) => Effect.Effect<Woken, never, RuntimeContext>
  readonly session: (terminalId: string, ownerId: string) => Effect.Effect<boolean, never, RuntimeContext>
  readonly alive: (terminalId: string, ownerId: string) => Effect.Effect<boolean, never, RuntimeContext>
  readonly enforce: (policy: Policy, revoked: ReadonlyArray<Revoked>) => Effect.Effect<void, never, RuntimeContext>
  readonly tool: (
    branch: SandboxBranch,
    ownerId: string,
    callId: string,
    call: SandboxTools.Call,
  ) => Effect.Effect<ToolOutcome, never, RuntimeContext>
  readonly command: (
    branch: SandboxBranch,
    ownerId: string,
    request: CommandRequest,
  ) => Effect.Effect<CommandOutcome, never, RuntimeContext>
  readonly sleepIfIdle: (
    generation: number,
    idleMs: number,
  ) => Effect.Effect<SleepOutcome | "unavailable", never, RuntimeContext>
  readonly ticket: () => Effect.Effect<string, never, RuntimeContext>
}

/** The `SandboxObject` Durable Object namespace: a branch's object is `getByName(branchId)`. */
export class SandboxObject extends Cloudflare.DurableObject<SandboxObject, SandboxObjectShape>()("SandboxObject") {}

/** The gate machine's namespace (`JobMachines.GATE`), the same object over the gate image; declared with GATE_IMAGE. */
export class GateObject extends Cloudflare.DurableObject<GateObject, SandboxObjectShape>()("GateObject") {}

/** A machine's object: its container class, the instance type it starts on, and the artifacts bucket its boxes reach. */
interface MachineSpec<CR, BR> {
  /** The job machine's name, none for the default machine. */
  readonly machine: string | undefined
  readonly container: Effect.Effect<Cloudflare.Container, never, CR>
  readonly instance: Config.Config<JobMachines.Instance>
  /** Binds the bucket in construction; answers the effect that reads its handle in a request. */
  readonly artifacts: Effect.Effect<Effect.Effect<Artifacts.Bucket, never, RuntimeContext>, never, BR> | undefined
}

const isBranch = Schema.is(SandboxBranch)

/**
 * The object's implementation: the branch's container, its checkout, its terminals, its forge and, with
 * `SANDBOX_SECRETS` on, its egress, which reaches Postgres through `connection`, the Hyperdrive config ChatApi binds.
 */
export const live = <E, R, CE, CR>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  checks: SocketChecks.Options,
  checkConnection: Effect.Effect<Cloudflare.Hyperdrive.Connection, CE, CR>,
) =>
  SandboxObject.make(implementation(connection, checks, checkConnection, {
    machine: undefined,
    container: BranchSandbox,
    instance: sandboxInstance,
    artifacts: undefined,
  }))

/**
 * The gate machine's objects (`GateObject`) when the deployment declares it (GATE_IMAGE), on GATE_INSTANCE, their
 * boxes reaching the run's artifacts in `CiArtifacts`; nothing otherwise, and nothing then yields `GateObject`.
 */
export const gateLive = <E, R, CE, CR>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  checks: SocketChecks.Options,
  checkConnection: Effect.Effect<Cloudflare.Hyperdrive.Connection, CE, CR>,
) =>
  Layer.unwrap(Effect.map(JobMachines.declared.pipe(Effect.orDie), (machines) => {
    const layer = GateObject.make(implementation(connection, checks, checkConnection, {
      machine: JobMachines.GATE,
      container: GateMachine,
      instance: JobMachines.gateInstance,
      artifacts: Effect.map(
        Cloudflare.R2.ReadWriteBucket(CiArtifacts),
        (bucket) => bucket.raw as unknown as Effect.Effect<Artifacts.Bucket, never, RuntimeContext>,
      ),
    }))
    // Undeclared, the namespace is never bound: the program yields `GateObject` only for a declared gate.
    return machines.includes(JobMachines.GATE) ? layer : (Layer.empty as unknown as typeof layer)
  }))

const implementation = <E, R, CE, CCR, CR, BR = never>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  checkOptions: SocketChecks.Options,
  /** The config its sockets' leases renew through: the request path's (worker/DatabaseRoutes.ts). */
  checkConnection: Effect.Effect<Cloudflare.Hyperdrive.Connection, CE, CCR>,
  spec: MachineSpec<CR, BR>,
) =>
  Effect.gen(function* () {
    const box = yield* spec.container
    // Session provisioning and machine commands share the SDK runner that discards unread output.
    const runBox = {
      exec: (argv: Array<string>, options: UserOptions) =>
        Effect.succeed({ exitCode: SandboxHost.run(box, argv, options) }),
    }
    const state = yield* Cloudflare.DurableObjectState
    const forge = yield* Effect.service(Forge).pipe(Effect.provide(Forge.layerConfig), Effect.provide(FetchHttpClient.layer))
    const secretsOn = yield* sandboxSecrets.pipe(Effect.orDie)
    const egressAllowHosts = yield* SandboxEgress.allowHosts.pipe(Effect.orDie)
    // The machine's own instance type (its spec), except an overflow box's, which starts on OVERFLOW_INSTANCE.
    const branchInstance = yield* spec.instance.pipe(Effect.orDie)
    const boxInstance = yield* overflowInstance.pipe(Effect.orDie)
    /** The instance type `branch`'s machine starts on: an overflow box's, or its machine's. */
    const instanceOf = (branch: SandboxBranch | undefined) =>
      branch !== undefined && Overflow.isBox(branch.branchId) ? boxInstance : branchInstance
    const startTimeoutMs = (yield* sandboxStartTimeoutSeconds.pipe(Effect.orDie)) * 1000
    const sessionOn = yield* configuredSessionOn
    const secretKeys = yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layerConfig), Effect.orDie)
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(connection)
    const database = Database.layer(hyperdrive.connectionString)
    const checks = yield* SocketChecks.checker(checkConnection, checkOptions)
    // Workers Logs keeps every JSON line, as it does ChatApi's and FlowExecution's. Without it this object's lines
    // (`sandbox.wake`, `sandbox.checkout`, `sandbox.forge`) never reached a log or a tail.
    // The machine's artifacts bucket, bound in construction; its handle is read per request.
    const artifactsBucket = spec.artifacts === undefined ? undefined : yield* spec.artifacts
    const logs = Logger.layerStructuredJson()
    const logged = <A, E, RE>(effect: Effect.Effect<A, E, RE>) => Effect.provide(effect, logs)
    return Effect.gen(function* () {
      // This incarnation's own scope: each socket's pump runs in it for as long as its socket is open, and the object
      // stays in memory while an accepted socket is (no hibernation, which would drop the tmux client's handle).
      const pumps = yield* Scope.make()
      /** Re-arms a running box's inactivity timeout; its failure is logged (`cloudflare.sandbox.rearm`) and ignored. */
      const rearm = Effect.ignore(SandboxHost.rearm(box))
      // A restarted object has no inactivity timeout, and Cloudflare stops its container soon after it goes idle, even
      // while a process runs: re-arm it now, in the constructor, as Cloudflare's docs say (`SandboxHost.rearm`).
      yield* logged(rearm)
      // Every socket attached now, with who attached it, so a change of the branch's sharing reaches it (`enforce`).
      const attached = new Map<
        WebSocket,
        {
          readonly principal: string
          readonly role: Role | null
          readonly access: "write" | "read"
          admission: SocketAccess.Admission
          /** Its lease (worker/SocketAccess.ts): every frame, out and in, passes only before `until`. */
          readonly lease: { until: number }
          readonly fiber: Fiber.Fiber<unknown>
        }
      >()
      /** The sockets a running renewal holds: an expiry beside it leaves their count to it. */
      const inRenewal = new Set<WebSocket>()
      /** One renewal at a time: a gate or the loop that finds one running waits for it. */
      const flight = SocketAccess.singleFlight()
      /** Every gate's one pending renewal: frames on lapsed leases start at most one fiber for the whole object. */
      let lapsed: (() => void) | undefined
      // The box's forge requests go to ChatApi's own entrypoint with props naming this object, and come back to it
      // (`answerBox`), which answers them as the forge proxy; every other request it makes does too, as its egress:
      // the package registries (worker/branch/RegistryEgress.ts), or with SANDBOX_SECRETS on, the secrets egress,
      // which allows them too. A check job's box always has the registry egress.
      // A job machine's box says which namespace its object is in (MACHINE_PROP), so ChatApi hands it back there.
      const own = Cloudflare.fromCloudflareFetcher(
        (state.raw as unknown as Loopback).exports.default({
          props: {
            [BOX_PROP]: state.id.toString(),
            ...(spec.machine === undefined ? {} : { [MACHINE_PROP]: spec.machine }),
          },
        }),
      )
      // A machine with an artifacts bucket answers its box's artifacts host too (worker/branch/Artifacts.ts).
      const intercepts = [
        { host: FORGE_HOST, fetcher: own },
        ...(artifactsBucket === undefined ? [] : [{ host: Artifacts.ARTIFACTS_HOST, fetcher: own }]),
      ]
      // One-use tickets ChatApi took for the sockets it is about to hand this object (TICKET_HEADER).
      const tickets = new Set<string>()
      const branchOf = state.storage.get<SandboxBranch>("branch").pipe(
        Effect.map((value) => (value !== undefined && isBranch(value) ? value : undefined)),
      )

      /** Starts the box unless it runs, and advances the generation when it started it. */
      const start = Effect.gen(function* () {
        const outcome = yield* SandboxHost.wake(box, {
          intercepts,
          egress: own,
          instance: instanceOf(yield* branchOf),
          startTimeoutMs,
        })
        const generation = (yield* state.storage.get<number>("generation")) ?? 0
        if (outcome === "running" && generation > 0) return generation
        yield* state.storage.put("generation", generation + 1)
        return generation + 1
      })

      /**
       * `start`, for `ownerId`: a generation it started takes the branch's slot in the sandbox ledger, with the instance
       * type it runs on (worker/branch/Budget.ts), so its awake time counts and is priced.
       */
      const startFor = (ownerId: string | undefined) =>
        Effect.gen(function* () {
          const before = (yield* state.storage.get<number>("generation")) ?? 0
          const generation = yield* start
          const branch = yield* branchOf
          if (generation !== before && branch !== undefined) {
            yield* Budget.started({
              branchId: branch.branchId,
              personId: Budget.personOf(ownerId),
              kind: Budget.kindOf(branch),
              generation,
              instance: instanceOf(branch),
            }).pipe(Effect.provide(database))
          }
          return generation
        })

      /**
       * Whether the sandbox limits let the branch's machine start for `ownerId` (worker/branch/Budget.ts): a running
       * machine needs nothing; a stopped one is admitted, or waits. A failure to ask fails the wake, which is tried again:
       * the limits are the deployment's hard cap, since Cloudflare's `durable_object` policy has no `max_instances`.
       */
      const admitted = (branch: SandboxBranch, ownerId: string | undefined) =>
        Effect.gen(function* () {
          const generation = (yield* state.storage.get<number>("generation")) ?? 0
          if (generation > 0 && (yield* box.running)) return true
          const slot = { branchId: branch.branchId, personId: Budget.personOf(ownerId), kind: Budget.kindOf(branch) }
          return (yield* Budget.observedAdmit(slot, database))._tag === "Admitted"
        })

      /** Runs `argv` as the machine's user `name`, answering its exit code. */
      const run = (argv: Array<string>, name: string) =>
        runOn(runBox, argv, name)

      // A wake's failure is logged with the step it failed in: the container's start, the checkout, the restore or
      // the placeholders, so a failure only production shows says where it happened. A wake that works logs how long
      // each step took, so a slow one says which step was slow.
      const wake = (branch: SandboxBranch, ownerId?: string) =>
        Effect.suspend(() => {
          let stage: WakeStage = "admit"
          const took: Partial<Record<`${WakeStage}Ms`, number>> = {}
          const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
              Effect.tap(effect, () =>
                Effect.map(Clock.currentTimeMillis, (now) => void (took[`${stage}Ms`] = now - startedAt))))
          return Effect.gen(function* () {
            yield* state.storage.put("branch", branch)
            if (!(yield* timed(admitted(branch, ownerId)))) return { _tag: "Waiting" } as const
            stage = "start"
            const generation = yield* timed(startFor(ownerId))
            // An overflow box checks nothing out: its runner keeps its own mirror and a checkout per job.
            if (Overflow.isBox(branch.branchId)) {
              stage = "placeholders"
              yield* timed(overflow(branch, generation))
              yield* Effect.logInfo("sandbox.wake").pipe(
                Effect.annotateLogs({ branchId: branch.branchId, outcome: "woken", generation, ...took }),
              )
              return { _tag: "Woken", generation } as const
            }
            stage = "checkout"
            const exit = yield* timed(run(checkoutArgv(branch.branch, forgeRemote(branch.owner, branch.name), branch.namespace), SANDBOX_USER))
            if (exit !== 0) {
              yield* Effect.logWarning("sandbox.checkout").pipe(
                Effect.annotateLogs({ branchId: branch.branchId, exitCode: exit, failure: CHECKOUT_FAILURES[exit] ?? "other" }),
              )
              return { _tag: "CheckoutFailed" } as const
            }
            // A fresh generation gets the working copy the last one saved (worker/branch/Machine.ts); once. A machine
            // that doesn't answer fails the wake, which is tried again, before anything can save over the checkpoint.
            stage = "restore"
            yield* timed(Machine.restore(machine, generation))
            stage = "placeholders"
            if (RegistryEgress.secretsEgress(branch, secretsOn)) yield* timed(placeholders(branch, generation))
            else yield* timed(trustEgress)
            stage = "agent"
            if (isTodoBox(branch) && ownerId !== undefined) yield* timed(agent(branch, ownerId, generation))
            yield* Effect.logInfo("sandbox.wake").pipe(
              Effect.annotateLogs({ branchId: branch.branchId, outcome: "woken", generation, ...took }),
            )
            return { _tag: "Woken", generation } as const
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.andThen(
                  Effect.logWarning("sandbox.wake").pipe(
                    Effect.annotateLogs({ branchId: branch.branchId, stage, ...failureFields(cause) }),
                  ),
                  // A machine that never started gives its slot back; one that did keeps it until it sleeps.
                  stage === "start" ? Budget.release(branch.branchId).pipe(Effect.provide(database), Effect.ignore) : Effect.void,
                ),
                startTimedOut(cause) ? { _tag: "Unavailable", reason: "start_timeout" } as const : { _tag: "Unavailable" } as const,
              )
            ),
          )
        }).pipe(Effect.withSpan("sandbox.object.wake", { attributes: { "smithers.branch.id": branch.branchId } }))

      /**
       * With the egress on, every wake writes the generation's placeholders to /run/smithers/env and trusts the
       * container's CA (SandboxEgress.SETUP), and the object keeps them for the tools' commands. Values never enter the box.
       */
      const placeholders = (branch: SandboxBranch, generation: number) =>
        Effect.gen(function* () {
          const environment = yield* SandboxEgress.environment(SandboxEgress.guestOf(branch, generation)).pipe(
            Effect.provideService(SecretKeys, secretKeys),
            Effect.provide(database),
          )
          yield* state.storage.put("environment", { generation, environment })
          const root = yield* ContainerSession.make(box, { id: state.id.toString(), workdir: "/", ...(yield* asUser("root")) })
          const code = yield* Effect.scoped(Effect.flatMap(
            root.spawn(SandboxEgress.SETUP, { stdin: new TextEncoder().encode(environment) }),
            (process) => process.exitCode,
          ))
          if (code !== 0) yield* Effect.logWarning("sandbox.egress.setup").pipe(Effect.annotateLogs({ exitCode: code }))
        }).pipe(
          // The box stays usable without its placeholders: its requests that need one are refused at the egress.
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox.egress.setup").pipe(Effect.annotateLogs(failureFields(cause)))
          ),
          Effect.withSpan("sandbox.egress.setup", { attributes: { "smithers.branch.id": branch.branchId } }),
        )

      /**
       * A TODO's box whose committer's list puts a subscription first: what the box's egress and the agent's commands
       * need of it, kept with the object. Placeholders only: the credential opens per request (`egressSubscription`).
       * Read on each wake, so the box follows the person's list.
       */
      const agent = (branch: SandboxBranch, ownerId: string, generation: number) =>
        Effect.gen(function* () {
          if (Option.isNone(secretKeys)) return yield* state.storage.delete("subscription")
          const keys = secretKeys.value
          const found = yield* Subscriptions.of(ownerId, keys).pipe(Effect.provide(database))
          if (Option.isNone(found)) return yield* state.storage.delete("subscription")
          const guest = SandboxEgress.guestOf(branch, generation)
          const placeholder = yield* SandboxEgress.subscriptionPlaceholder(guest, keys, found.value)
          const now = new Date(yield* Clock.currentTimeMillis)
          const environment = Agents.environment(found.value.agent, placeholder, {
            baseUrl: found.value.baseUrl,
            account: found.value.account,
            now,
          })
          yield* state.storage.put("subscription", {
            subscription: found.value,
            environment,
            user: userOf(ownerId),
          } satisfies BoxSubscription)
        }).pipe(
          // A box that can't read the person's list has no subscription, and its agent's first request is refused.
          Effect.catchCause((cause) =>
            Effect.andThen(
              state.storage.delete("subscription"),
              Effect.logWarning("sandbox.agent").pipe(Effect.annotateLogs(failureFields(cause))),
            )
          ),
          Effect.withSpan("sandbox.agent", { attributes: { "smithers.branch.id": branch.branchId } }),
        )

      const subscriptionOf = state.storage.get<BoxSubscription>("subscription")

      /** A request of the box's agent to its vendor's host, with the person's credential put in outside the box. */
      const egressSubscription = (held: BoxSubscription) =>
        Effect.gen(function* () {
          const branch = yield* branchOf
          const generation = yield* state.storage.get<number>("generation")
          if (branch === undefined || generation === undefined) return HttpServerResponse.empty({ status: 403 })
          return yield* SandboxEgress.forwardSubscription(SandboxEgress.guestOf(branch, generation), held.subscription, egressAllowHosts).pipe(
            Effect.provideService(SecretKeys, secretKeys),
            Effect.provide(Layer.merge(database, FetchHttpClient.layer)),
          )
        })

      /**
       * A box without secrets, a check job's included: the egress's CA trusted (SandboxEgress.TRUST), so its installs
       * reach the registries over HTTPS, and no environment file, since it holds no placeholder. A failure leaves the box
       * without the registries' HTTPS, and an install fails as it would offline.
       */
      const trustEgress = Effect.gen(function* () {
        const root = yield* ContainerSession.make(box, { id: state.id.toString(), workdir: "/", ...(yield* asUser("root")) })
        const code = yield* Effect.scoped(Effect.flatMap(root.spawn(SandboxEgress.TRUST, { stdin: new Uint8Array() }), (process) => process.exitCode))
        if (code !== 0) yield* Effect.logWarning("sandbox.egress.setup").pipe(Effect.annotateLogs({ exitCode: code }))
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("sandbox.egress.setup").pipe(Effect.annotateLogs(failureFields(cause)))),
        Effect.withSpan("sandbox.egress.trust"),
      )

      /**
       * A repository's overflow box (decision 0144, worker/runners/Overflow.ts): its two placeholders in the box's
       * environment file with the container's CA trusted (SandboxEgress.SETUP), then its runner's `runner.json` and
       * token placeholder written as `smithers`, and `smthrs runner serve` started detached in a login shell, which reads
       * them. The object keeps the credentials' rows for the egress (`egressOverflow`). A repository with overflow off,
       * or whose Admin's connection is gone, gets nothing started: the box sleeps again.
       */
      const overflow = (branch: SandboxBranch, generation: number) =>
        Effect.gen(function* () {
          yield* state.storage.delete("overflow")
          if (Option.isNone(secretKeys)) return yield* Effect.logWarning("sandbox.overflow").pipe(Effect.annotateLogs({ outcome: "off" }))
          const repo = SandboxEgress.guestOf(branch, generation).repoId
          const found = yield* Overflow.read(repo).pipe(Effect.provide(database))
          if (Option.isNone(found)) return yield* Effect.logWarning("sandbox.overflow").pipe(Effect.annotateLogs({ outcome: "off" }))
          const model = yield* Overflow.connectionOf(found.value.personId, found.value.connectionId).pipe(Effect.provide(database))
          if (Option.isNone(model)) return yield* Effect.logWarning("sandbox.overflow").pipe(Effect.annotateLogs({ outcome: "connection" }))
          const guest = SandboxEgress.guestOf(branch, generation)
          const placeholders = yield* SandboxEgress.overflowPlaceholders(guest, secretKeys.value, found.value)
          const plan = Overflow.boxPlan(found.value, placeholders, model.value, forgeRemote(branch.owner, branch.name))
          const credentials: SandboxEgress.OverflowCredentials = {
            repoId: repo,
            origin: found.value.origin,
            token: found.value.token,
            personId: found.value.personId,
            connectionId: found.value.connectionId,
            baseUrl: model.value.baseUrl,
          }
          yield* state.storage.put("overflow", credentials)
          const spawned = (name: string, script: string, stdin: string) =>
            Effect.gen(function* () {
              const session = yield* ContainerSession.make(box, { id: state.id.toString(), workdir: "/", ...(yield* asUser(name)) })
              return yield* Effect.scoped(Effect.flatMap(
                session.spawn(script, { stdin: new TextEncoder().encode(stdin) }),
                (process) => process.exitCode,
              ))
            })
          const runner = `${Overflow.BOX_HOME}/runner`
          const codes = [
            yield* spawned("root", SandboxEgress.SETUP, plan.environment),
            yield* spawned(SANDBOX_USER, `exec >/dev/null 2>&1; umask 077; mkdir -p ${runner} && cat >${runner}/runner.json`, plan.config),
            yield* spawned(SANDBOX_USER, `exec >/dev/null 2>&1; umask 077; cat >${runner}/runner-token`, plan.token),
            yield* spawned(SANDBOX_USER, "exec >/dev/null 2>&1; exec bash -l -s", plan.script),
          ]
          yield* Effect.logInfo("sandbox.overflow").pipe(
            Effect.annotateLogs({ branchId: branch.branchId, generation, outcome: codes[3] === 3 ? "no_runner" : codes.every((code) => code === 0) ? "started" : "failed", exitCodes: codes.join(",") }),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox.overflow").pipe(Effect.annotateLogs(failureFields(cause)))
          ),
          Effect.withSpan("sandbox.overflow", { attributes: { "smithers.branch.id": branch.branchId } }),
        )

      /** A request from an overflow box: through its own two credentials' egress, for the generation running now. */
      const egressOverflow = (credentials: SandboxEgress.OverflowCredentials) =>
        Effect.gen(function* () {
          const branch = yield* branchOf
          const generation = yield* state.storage.get<number>("generation")
          if (branch === undefined || generation === undefined) return HttpServerResponse.empty({ status: 403 })
          return yield* SandboxEgress.forwardOverflow(SandboxEgress.guestOf(branch, generation), credentials, egressAllowHosts).pipe(
            Effect.provideService(SecretKeys, secretKeys),
            Effect.provide(Layer.merge(database, FetchHttpClient.layer)),
          )
        })

      /**
       * What a tool's command gets: its tools' trust of the egress's CA (`RegistryEgress.trustOf`), every box's, and
       * with the secrets egress, the running generation's placeholders too. The trust comes last, so no secret's name
       * can take it away.
       */
      const environmentNow = Effect.gen(function* () {
        const trust = RegistryEgress.trustOf(SandboxEgress.CONTAINER_CA)
        if (!RegistryEgress.secretsEgress(yield* branchOf, secretsOn)) return trust
        const kept = yield* state.storage.get<{ readonly generation: number; readonly environment: string }>("environment")
        const generation = yield* state.storage.get<number>("generation")
        return kept !== undefined && kept.generation === generation ? { ...variablesOf(kept.environment), ...trust } : trust
      })

      // The machine as its tools and lifecycle use it (worker/branch/Machine.ts, docs/features/sandbox-tools.md).
      const machine: Machine.Box<RuntimeContext> = {
        sessionAs: (name) =>
          Effect.gen(function* () {
            const placeholders = yield* environmentNow
            const held = yield* subscriptionOf
            const { env, user } = yield* asUser(name)
            return yield* ContainerSession.make(box, {
              id: state.id.toString(),
              workdir: WORKSPACE,
              user,
              // Only the committer's own commands get their agent's placeholder: never another person's shell.
              env: { ...placeholders, ...(held?.user === name ? held.environment : {}), ...env },
            })
          }),
        run,
        running: box.running,
        destroy: box.destroy(),
        storage: {
          get: (key) => state.storage.get(key),
          put: (key, value) => state.storage.put(key, value),
          delete: (key) => state.storage.delete(key),
          list: (prefix) => state.storage.list({ prefix }),
        },
      }

      /** Saves the running generation's working copy, as a terminal comes or goes; nothing when the box is stopped. */
      // A socket that closed leaves a save due for the next ask (`Machine.sleepIfIdle`, within a minute) rather than
      // saving here: run from the closed socket's own request, the checkpoint was killed (exit 137) every time in
      // production, while the same save from an ask or a tool call succeeds.
      const saveNow = Machine.saveLater(machine).pipe(Effect.ignore)

      /** Runs one sandbox tool on the branch's machine, waking it first (worker/branch/Machine.ts). */
      const tool = (branch: SandboxBranch, ownerId: string, callId: string, call: SandboxTools.Call) =>
        Effect.gen(function* () {
          const woken = yield* wake(branch, ownerId)
          if (woken._tag !== "Woken") return woken
          return yield* Machine.tool(machine, { ownerId, callId, call, generation: woken.generation })
        })

      /**
       * Runs one operation on a command started detached in the branch's machine (worker/branch/Machine.ts): a start
       * wakes the machine first; the rest re-arm a running box's inactivity timeout and answer for the generation
       * running now, none when it stopped, so a command whose machine went observes `lost`.
       */
      const command = (branch: SandboxBranch, ownerId: string, request: CommandRequest) =>
        Effect.gen(function* () {
          if (request.op === "start") {
            const woken = yield* wake(branch, ownerId)
            if (woken._tag !== "Woken") return woken
            return yield* Machine.command(machine, { ownerId, request, generation: woken.generation })
          }
          yield* rearm
          const generation = (yield* box.running) ? yield* state.storage.get<number>("generation") : undefined
          return yield* Machine.command(machine, { ownerId, request, generation })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("sandbox.object.command").pipe(Effect.annotateLogs(failureFields(cause))),
              { _tag: "Unavailable" } as const,
            )
          ),
        )

      // Each ask re-arms the inactivity timeout first, so a box this object restarted under (a deploy) keeps its backstop
      // while `sandbox/Keep` decides.
      const sleepIfIdle = (generation: number, idleMs: number) =>
        Effect.andThen(rearm, Machine.sleepIfIdle(machine, generation, idleMs)).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("sandbox.object.sleep").pipe(Effect.annotateLogs(failureFields(cause))),
              "unavailable" as const,
            )
          ),
        )

      // Each person's shell runs as their own user, made on first use (worker/branch/Users.ts). Opening one is use.
      const session = (terminalId: string, ownerId: string) =>
        sessionOn({
          box: runBox, start: startFor(ownerId), touch: Machine.touch(machine),
          ensureSession: (options) => ContainerTerminal.ensureSession(box, options),
        })(terminalId, ownerId)

      const alive = (terminalId: string, ownerId: string) =>
        Effect.gen(function* () {
          yield* rearm
          if (!ContainerTerminal.isSessionName(terminalId) || !(yield* box.running)) return false
          return (yield* run(["tmux", "has-session", "-t", `=${terminalId}`], userOf(ownerId))) === 0
        }).pipe(Effect.catchCause(() => Effect.succeed(false)))

      /** A socket ChatApi admitted: attached to the terminal's session for as long as it is open. */
      const attach = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const terminalId = request.headers[TERMINAL_HEADER] ?? ""
          const ownerId = request.headers[OWNER_HEADER] ?? ""
          const principal = request.headers[PRINCIPAL_HEADER] ?? ""
          const access = request.headers[ACCESS_HEADER] === "write" ? "write" : "read"
          const admission = SocketAccess.admissionOf(request)
          if (!ContainerTerminal.isSessionName(terminalId) || ownerId === "" || principal === "" || admission === undefined) {
            return HttpServerResponse.empty({ status: 400 })
          }
          // A session that ended on the way here gets nothing; nor does a person over the cap.
          if (SocketAccess.ended(admission, yield* Clock.currentTimeMillis)) return HttpServerResponse.empty({ status: 401 })
          if (SocketAccess.crowded([...attached.values()].map((viewer) => viewer.admission), principal)) {
            return HttpServerResponse.empty({ status: 429 })
          }
          yield* rearm
          const { env, user } = yield* asUser(userOf(ownerId))
          const pair = new WebSocketPair()
          const [client, server] = [pair[0], pair[1]]
          server.accept()
          const lease = { until: SocketAccess.leaseFrom(admission, admission.admittedAt) }
          // The gate is called from the socket's own events, outside any effect: it renews with this object's services.
          const runFork = Effect.runForkWith(yield* Effect.context<RuntimeContext>())
          const clock = yield* Effect.clockWith(Effect.succeed)
          // The terminal reads and writes through the lease: input and output both stop the moment it lapses or the
          // session ends, and the object's one renewal is asked for.
          const leased = SocketAccess.gate(
            server,
            () => {
              const now = clock.currentTimeMillisUnsafe()
              return now < lease.until && !SocketAccess.ended(admission, now)
            },
            lapsed ??= SocketAccess.coalesced(renewDue, runFork),
          )
          const fiber = yield* Effect.forkIn(
            ContainerTerminal.attach(box, leased, { name: terminalId, user, access, cols: 80, rows: 24, env })
              .pipe(Effect.ensuring(Effect.sync(() => attached.delete(server))), Effect.ensuring(saveNow)),
            pumps,
          )
          attached.set(server, { principal, role: roleOf(request.headers[ROLE_HEADER]), access, admission, lease, fiber })
          // Both loops run while anyone is attached; a lease acted on before a running one's wake wakes it then.
          yield* loop.ensure(pumps, { admission, leaseUntil: lease.until })
          return HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: 101 }),
            HttpBody.raw(new Response(null, { status: 101, webSocket: client })),
          )
        })

      /**
       * A request from the box to any other host, with the egress on: the secrets egress, for the guest this object's
       * own state names, never the request.
       */
      const egressOut = Effect.gen(function* () {
        const branch = yield* branchOf
        const generation = yield* state.storage.get<number>("generation")
        if (branch === undefined || generation === undefined) return HttpServerResponse.empty({ status: 403 })
        return yield* SandboxEgress.forward(SandboxEgress.guestOf(branch, generation), egressAllowHosts).pipe(
          Effect.provideService(SecretKeys, secretKeys),
          Effect.provide(Layer.merge(database, FetchHttpClient.layer)),
        )
      })

      /**
       * A request from the box to its forge: the read-only git proxy, with the read credential added here. Each logs
       * `sandbox.forge` with its status, never its path or body.
       */
      const egress = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const branch = yield* branchOf
          if (branch === undefined) {
            yield* Effect.logWarning("sandbox.forge").pipe(Effect.annotateLogs({ status: 403, outcome: "no_branch" }))
            return HttpServerResponse.empty({ status: 403 })
          }
          const response = yield* proxy(request, forge, branch).pipe(Effect.provide(FetchHttpClient.layer))
          yield* Effect.logInfo("sandbox.forge").pipe(
            Effect.annotateLogs({ branchId: branch.branchId, status: response.status, outcome: "answered" }),
          )
          return response
        }).pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("sandbox.forge").pipe(Effect.annotateLogs({ outcome: "failed", ...failureFields(cause) }))
          ),
        )

      /**
       * Renews the leases of `sockets` by the rules ChatApi admitted them with (worker/SocketAccess.ts). Every socket that
       * can't be renewed leaves `attached` before any closes; its pump stops on its own time, never waited on.
       */
      const renewViewers = (sockets: ReadonlyArray<WebSocket>): Effect.Effect<void, never, RuntimeContext> =>
        Effect.gen(function* () {
          const due = sockets.flatMap((socket) => {
            const viewer = attached.get(socket)
            return viewer === undefined ? [] : [{ socket, viewer }]
          })
          if (due.length === 0) return
          for (const { socket } of due) inRenewal.add(socket)
          const verdicts = yield* SocketAccess.renew<RuntimeContext | SqlClient.SqlClient, RuntimeContext>(
            "terminal",
            due.map(({ viewer }) => viewer.admission),
            checks.check,
            checks.within,
          ).pipe(Effect.ensuring(Effect.sync(() => {
            for (const { socket } of due) inRenewal.delete(socket)
          })))
          const now = yield* Clock.currentTimeMillis
          const ending: Array<readonly [WebSocket, Fiber.Fiber<unknown>, SocketAccess.Closing]> = []
          due.forEach(({ socket, viewer }, index) => {
            const { verdict, until, admission } = verdicts[index]!
            // A socket detached while its check ran stays detached.
            if (attached.get(socket) !== viewer) return
            // The window its check measured, from when that check started (decision 0151 rule 9).
            if (verdict === "keep") {
              viewer.lease.until = until ?? SocketAccess.leaseFrom(viewer.admission, now)
              viewer.admission = admission
            } else {
              viewer.lease.until = 0
              attached.delete(socket)
              ending.push([socket, viewer.fiber, verdict])
            }
          })
          for (const [socket, fiber, closing] of ending) {
            const close = SocketAccess.CLOSES[closing]
            yield* SocketAccess.safely(Effect.sync(() => socket.close(close.code, close.reason)))
            yield* Effect.forkIn(Fiber.interrupt(fiber), pumps)
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("sandbox.renew").pipe(Effect.annotateLogs(failureFields(cause)))),
          logged,
        )

      /** Renews every lease due now (`SocketAccess.due`), one renewal at a time. */
      const renewDue: Effect.Effect<void, never, RuntimeContext> = flight(Effect.flatMap(Clock.currentTimeMillis, (now) =>
        renewViewers(
          [...attached].filter(([, viewer]) => SocketAccess.due(viewer.admission, viewer.lease.until, now)).map(([s]) => s),
        )))

      /**
       * Acts on leases `RENEW_AHEAD_MS` before the first lapses (at the session's end for one it caps), renewing every
       * one due together, for as long as any socket is attached. The object never hibernates while one is, so a fiber in
       * `pumps` keeps the time. An attach never moves it: a lease that lapses first stops its socket's frames at once,
       * and the gate asks for the renewal.
       */
      /**
       * Closes every socket whose session has ended, with no query and never waiting on a renewal: it leaves `attached`
       * and closes `4401`, and its pump stops on its own time.
       */
      const expire: Effect.Effect<void, never, RuntimeContext> = Effect.gen(function* () {
        const open = [...attached].map(([socket, viewer]) => ({ socket, admission: viewer.admission, viewer }))
        const ended = yield* SocketAccess.expireEnded("terminal", open, inRenewal)
        for (const { socket, viewer } of ended) {
          viewer.lease.until = 0
          attached.delete(socket)
        }
        for (const { socket, viewer } of ended) {
          const close = SocketAccess.CLOSES.session
          yield* SocketAccess.safely(Effect.sync(() => socket.close(close.code, close.reason)))
          yield* Effect.forkIn(Fiber.interrupt(viewer.fiber), pumps)
        }
        if (ended.length > 0) yield* Effect.logInfo("sandbox.expire").pipe(Effect.annotateLogs({ closed: ended.length }))
      })
      const loop = SocketAccess.renewalLoop(
        () => [...attached.values()].map((viewer) => ({ admission: viewer.admission, leaseUntil: viewer.lease.until })),
        renewDue,
        expire,
        "terminal",
      )

      /**
       * Holds every attached socket to the branch's permission list as it now stands: a viewer who lost the branch is
       * detached for good (1008), one whose access changed reconnects (1011) and attaches with the new one. Then each
       * revoked terminal's shell ends, which ends every socket still on it. Never starts the box.
       */
      const enforce = (policy: Policy, revoked: ReadonlyArray<Revoked>) =>
        Effect.gen(function* () {
          let detached = 0
          for (const [socket, viewer] of attached) {
            const now = underPolicy(policy, viewer.principal, viewer.role)
            const code = !canView(now) ? 1008 : (canEdit(now) ? "write" : "read") !== viewer.access ? 1011 : undefined
            if (code === undefined) continue
            attached.delete(socket)
            detached++
            yield* SocketAccess.safely(Effect.sync(() => socket.close(code, code === 1008 ? "no access" : "access changed")))
            yield* Fiber.interrupt(viewer.fiber)
          }
          yield* rearm
          if (revoked.length > 0 && (yield* box.running)) {
            for (const terminal of revoked) {
              if (!ContainerTerminal.isSessionName(terminal.terminalId)) continue
              yield* run(["tmux", "kill-session", "-t", `=${terminal.terminalId}`], userOf(terminal.ownerId)).pipe(
                Effect.ignore,
              )
            }
          }
          yield* Effect.logInfo("sandbox.enforce").pipe(
            Effect.annotateLogs({ detached, revoked: revoked.length, attached: attached.size }),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox.enforce").pipe(Effect.annotateLogs(failureFields(cause)))
          ),
          Effect.withSpan("sandbox.object.enforce"),
        )

      // Every method logs as JSON (`logs`).
      return {
        wake: (branch: SandboxBranch, ownerId?: string) => logged(wake(branch, ownerId)),
        session: (terminalId: string, ownerId: string) => logged(session(terminalId, ownerId)),
        alive: (terminalId: string, ownerId: string) => logged(alive(terminalId, ownerId)),
        enforce: (policy: Policy, revoked: ReadonlyArray<Revoked>) => logged(enforce(policy, revoked)),
        tool: (branch: SandboxBranch, ownerId: string, callId: string, call: SandboxTools.Call) =>
          logged(tool(branch, ownerId, callId, call)),
        command: (branch: SandboxBranch, ownerId: string, request: CommandRequest) =>
          logged(command(branch, ownerId, request)),
        sleepIfIdle: (generation: number, idleMs: number) => logged(sleepIfIdle(generation, idleMs)).pipe(
          Effect.annotateLogs({ sandboxObjectId: state.id.toString(), attachedSockets: attached.size }),
        ),
        ticket: () =>
          Effect.sync(() => {
            const ticket = crypto.randomUUID()
            tickets.add(ticket)
            return ticket
          }),
        fetch: logged(Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const host = new URL(request.originalUrl).host
          if (host === FORGE_HOST) return yield* egress(request)
          // The run's artifacts, under the scope this object's own branch names, never the request.
          if (host === Artifacts.ARTIFACTS_HOST && artifactsBucket !== undefined) {
            const bucket = yield* artifactsBucket
            return yield* Artifacts.answer(request, (yield* branchOf)?.artifacts).pipe(
              Effect.provide(Artifacts.layerR2(bucket, (bytes) => new FixedLengthStream(bytes))),
            )
          }
          // Only ChatApi holds a ticket: a socket it hands over is attached, once per ticket.
          if (tickets.delete(request.headers[TICKET_HEADER] ?? "")) return yield* attach(request)
          // Every other request is the box's own, out through its egress. An overflow box's go only through its own
          // credentials' egress; a TODO box's agent's to its vendor first.
          const overflowing = yield* state.storage.get<SandboxEgress.OverflowCredentials>("overflow")
          if (overflowing !== undefined) return yield* egressOverflow(overflowing)
          const held = yield* subscriptionOf
          if (held?.subscription.hosts.includes(new URL(request.originalUrl).hostname)) {
            return yield* egressSubscription(held)
          }
          if (RegistryEgress.secretsEgress(yield* branchOf, secretsOn)) return yield* egressOut
          return yield* RegistryEgress.forward(request).pipe(Effect.provide(FetchHttpClient.layer))
        })),
      }
    })
  })

/** The namespace as ChatApi and the flow host hold it once they have bound it (`yield* SandboxObject`). */
type Objects = Cloudflare.DurableObject<SandboxObjectShape>

/**
 * Starts generation `generation`'s `sandbox/Keep` (worker/flows/SandboxKeep.ts) for the branch's machine (`machine`, none
 * for the default one); the same generation again is a no-op.
 */
export type Keep = (branchId: string, generation: number, machine?: string) => Effect.Effect<void, never, RuntimeContext>

/**
 * The namespace of each machine the deployment declared, by its name: the default machine's for none, a declared job
 * machine's for its name, nothing for any other.
 */
export type Namespaces = (machine: string | undefined) => Objects | undefined

/** `Namespaces` over the default namespace and, when the deployment declared the gate, the gate's. */
export const namespaces = (objects: Objects, gate: Objects | undefined): Namespaces => (machine) =>
  machine === undefined ? objects : machine === JobMachines.GATE ? gate : undefined

const noKeep: Keep = () => Effect.void

/**
 * The flow host's `Sandboxes` over the bound namespace, for the runtime that calls it. Each wake starts its
 * generation's `sandbox/Keep` through `keep`.
 */
export const sandboxesOver = (objects: Objects, keep: Keep = noKeep) => Effect.gen(function* () {
  const runtime = yield* RuntimeContext
  return Sandboxes.of({
    wake: (branch, ownerId) =>
      Effect.gen(function* () {
        const woken: Woken = yield* objects.getByName(branch.branchId).wake(branch, ownerId).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.orElseSucceed((): Woken => ({ _tag: "Unavailable" })),
        )
        if (woken._tag === "CheckoutFailed") return yield* new CheckoutFailed()
        if (woken._tag === "Waiting") return yield* new SandboxUnavailable({ reason: "waiting" })
        if (woken._tag === "Unavailable") return yield* new SandboxUnavailable({ reason: "start" })
        yield* keep(branch.branchId, woken.generation).pipe(Effect.provideService(RuntimeContext, runtime))
        return { generation: woken.generation }
      }),
    session: (branchId, terminalId, ownerId) =>
      objects.getByName(branchId).session(terminalId, ownerId).pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.orElseSucceed(() => false),
        Effect.flatMap((started) => (started ? Effect.void : Effect.fail(new SandboxUnavailable({ reason: "exec" })))),
      ),
  })
})

/** ChatApi's `TerminalSockets` over the bound namespace, for the request that calls it. */
export const terminalSocketsOver = (objects: Objects) => Effect.gen(function* () {
  const runtime = yield* RuntimeContext
  return TerminalSockets.of({
    attach: (branchId: string, attachment: Attachment) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Only these headers say who attaches; any `x-smithers-*` the browser sent is dropped first.
        const ticket = yield* objects.getByName(branchId).ticket().pipe(Effect.provideService(RuntimeContext, runtime))
        const forwarded = SocketAccess.forward(request, attachment.admission, {
          [TICKET_HEADER]: ticket,
          [TERMINAL_HEADER]: attachment.terminalId,
          [OWNER_HEADER]: attachment.ownerId,
          [ACCESS_HEADER]: attachment.access,
          [PRINCIPAL_HEADER]: attachment.principal,
          [ROLE_HEADER]: attachment.role ?? "",
        })
        return yield* objects.getByName(branchId).fetch(forwarded).pipe(Effect.provideService(RuntimeContext, runtime))
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 }))),
    alive: (branchId, terminalId, ownerId) =>
      objects.getByName(branchId).alive(terminalId, ownerId).pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.orElseSucceed(() => false),
      ),
    enforce: (branchId, policy, revoked) =>
      objects.getByName(branchId).enforce(policy, revoked).pipe(
        Effect.provideService(RuntimeContext, runtime),
        Effect.mapError(() => new SandboxUnavailable({ reason: "exec" })),
      ),
  })
})

/**
 * ChatApi's answer to a request a branch's box sent (`boxOf` its `props`): handed back to that box's own object, in its
 * machine's namespace, which answers it as the box's forge, its artifacts or its egress. 502 when the object can't be
 * reached or its machine isn't declared here.
 */
export const answerBox = (objectsFor: Namespaces, box: { readonly id: string; readonly machine?: string }) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext
    const request = yield* HttpServerRequest.HttpServerRequest
    const objects = objectsFor(box.machine)
    if (objects === undefined) return yield* Effect.die(new Error("undeclared machine"))
    return yield* objects.get(objects.idFromString(box.id)).fetch(request).pipe(
      Effect.provideService(RuntimeContext, runtime),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("sandbox.box_request").pipe(Effect.annotateLogs(failureFields(cause))),
        HttpServerResponse.empty({ status: 502 }),
      )
    ),
  )

/** `Sandboxes` as a layer, built in the runtime that runs the flows (`RuntimeContext`). */
export const sandboxesLayer = (objects: Objects, keep: Keep = noKeep) =>
  Layer.effect(Sandboxes, sandboxesOver(objects, keep))

/**
 * The flow host's `Machines` over the deployment's namespaces (docs/features/sandbox-tools.md,
 * docs/features/ci.md#machines): a call runs on the object of the branch's machine, which wakes it; the generation it
 * ran on gets its `sandbox/Keep` through `keep`, with the machine (worker/branch/Machines.ts `routed`). A branch naming
 * a machine the deployment didn't declare wakes nothing.
 */
export const machinesOver = (objectsFor: Namespaces, keep: Keep = noKeep) => Effect.gen(function* () {
  const runtime = yield* RuntimeContext
  const objectOf = (branchId: string, machine: string | undefined): MachineObject | undefined => {
    const objects = objectsFor(machine)
    if (objects === undefined) return undefined
    const object = () => objects.getByName(branchId)
    return {
      tool: (branch, ownerId, callId, call) =>
        object().tool(branch, ownerId, callId, call).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.orElseSucceed((): ToolOutcome => ({ _tag: "Unavailable" })),
        ),
      command: (branch, ownerId, request) =>
        object().command(branch, ownerId, request).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.orElseSucceed((): CommandOutcome => ({ _tag: "Unavailable" })),
        ),
      sleepIfIdle: (generation, idleMs) =>
        object().sleepIfIdle(generation, idleMs).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.orElseSucceed(() => "unavailable" as const),
        ),
    }
  }
  return Machines.of(routed(
    objectOf,
    (branchId, generation, machine) => keep(branchId, generation, machine).pipe(Effect.provideService(RuntimeContext, runtime)),
  ))
})

/** `Machines` as a layer, built in the runtime that runs the flows (`RuntimeContext`). */
export const machinesLayer = (objectsFor: Namespaces, keep: Keep = noKeep) =>
  Layer.effect(Machines, machinesOver(objectsFor, keep))
