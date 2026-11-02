import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Clock, Duration, Effect, Layer, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { CODING_AGENTS } from "../../src/features/personal-model/contract.ts"
import { Machines } from "../branch/Machines.ts"
import * as Agents from "../personal/Agents.ts"
import * as Codex from "../personal/Codex.ts"
import * as Subscriptions from "../personal/Subscriptions.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as SandboxCommand from "./SandboxCommand.ts"
import { Implemented, ImplementPayload, promptOf, SYSTEM, TOOL_CALL_NAMESPACE } from "./TodoAgent.ts"
import * as Machine from "./TodoMachine.ts"

// `todo/Route` and `todo/ImplementCli` (decision 0132, ruling AUTH-10, docs/features/personal-model.md#subscriptions).
// A person whose list puts a Claude or Codex subscription first has their change written by the vendor's own agent, the
// official Claude Code or Codex, in the attempt's box, on their own plan. This is the exception AUTH-10 makes to "every
// model call is a durable step": that CLI's loop and its model calls happen inside it, so the durable unit is one
// `sandbox/Command` job, started once per attempt, parked on and collected once, exactly as the Smithers agent's commands.
// What it writes reaches the working copy; `todo/Collect` publishes it the same way for either agent.

/** The agent `todo/Route` chose. */
export const Routed = Schema.Struct({ agent: Schema.Literals(CODING_AGENTS) })

/** A run's agent answered without a usable result. Its code only: the output may hold anything. */
export class AgentCliFailed extends Schema.TaggedError<AgentCliFailed>()("@smthrs/mvp/todo/AgentCliFailed", {
  reason: Schema.Literals(["no_machine", "no_credential", "exit", "timeout", "lost"]),
}) {}

/** Postgres or OpenAI couldn't say. Retried. */
export class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()("@smthrs/mvp/todo/RouteUnavailable", {}) {}

/** `todo/Route`: which agent writes this attempt, sealed for the attempt, from the committer's list as it stands now. */
export const Route = Action.make("todo/Route", {
  payload: { ownerId: Schema.String },
  success: Routed,
  error: RouteUnavailable,
  capabilities: ["db:read:personal_models"],
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 }),
})

/** `todo/ImplementCli`: the vendor's agent writes the TODO's change in the attempt's box. */
export const ImplementCli = Action.make("todo/ImplementCli", {
  payload: { ...ImplementPayload, agent: Schema.Literals(["claude-code", "codex"]) },
  success: Implemented,
  error: Schema.Union([AgentCliFailed, RouteUnavailable]),
  capabilities: ["sandbox:run"],
  // Safe to repeat: the command joins its job by the attempt's call id. A failed agent stays failed.
  retryPolicy: RetryPolicy.make({
    initialMs: 1_000,
    factor: 2,
    maxMs: 60_000,
    expirationMs: 30 * 60_000,
    nonRetryable: ["@smthrs/mvp/todo/AgentCliFailed"],
  }),
})

/** How long the agent may run: the same 40 minutes of its own as the Smithers agent, in one command. */
export const AGENT_SECONDS = 40 * 60

/** What the vendor's agent is told: the Smithers agent's rules, minus the tools it doesn't have. */
const rules = SYSTEM.filter((line) => !line.startsWith("Every capability")).map((line) =>
  line.replace(/^You implement one TODO in a git repository checked out on a machine\..*$/, "You implement one TODO in this git checkout.")
    .replace(/ Use sandbox\/status and sandbox\/diff rather than git commands\./, "")
    .replace(/ A sandbox\/run command takes/, " A command takes")
)

/** The prompt the agent reads on stdin. */
export const promptFor = (payload: Schema.Struct.Type<typeof ImplementPayload>) =>
  [...rules, "", promptOf(payload)].join("\n")

/** What `todo/ImplementCli` opens and refreshes a subscription's token with. */
export type Credentials = Layer.Layer<SecretKeys | Codex.CodexAuth>

/** Secrets off: a subscription's run ends `no_credential`. */
const noCredentials: Credentials = Layer.merge(SecretKeys.off, Layer.succeed(Codex.CodexAuth, { origin: "", clientId: "" }))

/** `todo/Route` and `todo/ImplementCli` over `database`, the host's `Machines` and `credentials`. */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  commandSeconds: number,
  stepWaitSeconds: number,
  credentials: Credentials = noCredentials,
) =>
  Layer.mergeAll(
    Route.toLayer(({ ownerId }) =>
      Subscriptions.agentOf(ownerId).pipe(
        Effect.provide(database),
        Effect.map((agent) => ({ agent })),
        Effect.mapError(() => new RouteUnavailable()),
      )
    ),
    Layer.unwrap(Effect.gen(function* () {
      const machines = yield* Machines
      const keys = yield* SecretKeys
      const codexAuth = yield* Codex.CodexAuth
      const context = yield* Effect.context<R>()
      const inDatabase = <A, E2>(effect: Effect.Effect<A, E2, SqlClient.SqlClient>) =>
        effect.pipe(Effect.provide(database), Effect.provideContext(context))
      const seconds = Math.min(AGENT_SECONDS, commandSeconds)
      return ImplementCli.toLayer(({ agent, ...payload }) =>
        Effect.gen(function* () {
          const instance = yield* FlowRuntime.FlowInstance
          const machine = yield* inDatabase(Machine.ofExecution(instance.executionId)).pipe(
            Effect.mapError(() => new RouteUnavailable()),
          )
          if (Option.isNone(machine)) return yield* new AgentCliFailed({ reason: "no_machine" })
          if (Option.isNone(keys)) return yield* new AgentCliFailed({ reason: "no_credential" })
          const { branch, ownerId } = machine.value
          // Only Codex's token: a Claude run doesn't depend on a Codex connection further down the list.
          if (agent === "codex") {
            yield* inDatabase(Subscriptions.fresh(ownerId, keys.value).pipe(Effect.provideService(Codex.CodexAuth, codexAuth))).pipe(
              Effect.mapError((failure): AgentCliFailed | RouteUnavailable =>
                failure instanceof Codex.CodexAuthFailed && failure.reason === "refused"
                  ? new AgentCliFailed({ reason: "no_credential" })
                  : new RouteUnavailable()
              ),
            )
          }
          const callId = yield* Uuid.v5(TOOL_CALL_NAMESPACE, `${payload.attemptId}:${agent}`).pipe(
            Effect.provide(WebCrypto.layer),
            Effect.orDie,
          )
          const call = {
            tool: "run" as const,
            command: Agents.commandOf(agent, promptFor(payload), undefined),
            timeoutSeconds: seconds,
          }
          const startedAt = yield* Clock.currentTimeMillis
          const ran = yield* SandboxCommand.run(
            machines,
            { branch, ownerId },
            callId,
            call,
            Duration.seconds(Math.min(seconds + 15, stepWaitSeconds)),
          ).pipe(Effect.mapError(() => new AgentCliFailed({ reason: "lost" })))
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt
          const failed = ran.timedOut ? "timeout" : ran.exitCode === 0 ? undefined : "exit"
          const report = Agents.reportOf(agent, ran.stdout)
          yield* Effect.logWithLevel(failed === undefined ? "Info" : "Warn")("todo.agent_cli").pipe(
            Effect.annotateLogs({
              agent,
              outcome: failed ?? "done",
              exitCode: ran.exitCode,
              durationMs,
              inputTokens: report.inputTokens ?? 0,
              outputTokens: report.outputTokens ?? 0,
            }),
          )
          if (failed !== undefined) return yield* new AgentCliFailed({ reason: failed })
          return { summary: report.summary }
        }).pipe(
          // What didn't reach the box: `no_machine`, `no_credential`, `lost`. Its code only.
          Effect.tapError((failure) =>
            failure instanceof AgentCliFailed && (failure.reason === "exit" || failure.reason === "timeout")
              ? Effect.void
              : Effect.logWarning("todo.agent_cli").pipe(Effect.annotateLogs({
                agent,
                outcome: failure instanceof AgentCliFailed ? failure.reason : "unavailable",
              }))
          ),
          Effect.withSpan("todo.agent_cli", { attributes: { "smithers.agent": agent } }),
        )
      )
    })),
  ).pipe(Layer.provide(credentials))

