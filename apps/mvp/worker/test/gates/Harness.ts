// The gate proof's stage (decision 0128 "Proof"): ChatApi itself, deployed to a `smithers-gates-*` stage only, with one
// door of its own in front: a caller holding the harness token starts `ci/graph` on a planned gate and reads its run.
// The stage has no GitHub App, so nothing plans the gate from a webhook or reports a status; the door stands in for
// `repo/Run`'s plan, and every other hop (FlowExecution, ci/graph, ci/job, the gate machines, the artifacts) is the
// deployment's own. No deploy of ChatApi (alchemy.run.ts) includes this file.
import * as Cloudflare from "alchemy/Cloudflare"
import { CiJob } from "@smthrs/sandbox"
import { digestSync } from "@smthrs/crypto"
import { Config, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { props } from "../../ChatApi.ts"
import type { Door } from "../../ChatApiProgram.ts"
import * as ExecutionHost from "../../ExecutionHost.ts"
import * as Budget from "../../branch/Budget.ts"

/** What starts a gate: the execution's id, the commit's target, and the jobs `repo/Plan` would have planned. */
export const Start = Schema.Struct({ executionId: Schema.String, target: CiJob.Target, jobs: CiJob.Jobs })

const PREFIX = "/gate-harness/"

/** The door: `POST /gate-harness/start` and `GET /gate-harness/run/<executionId>`, for the token whose SHA-256 is `tokenSha256`. */
export const door = (tokenSha256: string) => ({ database, executions }: Door) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.originalUrl).pathname
    if (!path.startsWith(PREFIX)) return Option.none()
    const offered = digestSync(request.headers["x-gate-harness"] ?? "")
    if (tokenSha256.length !== 64 || offered !== tokenSha256) return Option.some(HttpServerResponse.empty({ status: 404 }))
    if (request.method === "POST" && path === `${PREFIX}start`) {
      const start = yield* Effect.flatMap(request.json, Schema.decodeUnknownEffect(Start))
      const intent = yield* ExecutionHost.intent(CiJob.Graph, {
        executionId: start.executionId,
        payload: { target: start.target, jobs: start.jobs },
      })
      yield* executions.getByName(start.executionId).start(intent)
      return Option.some(yield* HttpServerResponse.json({ started: start.executionId }, { status: 202 }))
    }
    // The deployment's awake-machine limit, as an Admin sets it in Settings: one gate wants 17 machines at once.
    if (request.method === "POST" && path === `${PREFIX}limits`) {
      const limits = yield* Effect.flatMap(request.json, Schema.decodeUnknownEffect(Schema.Struct({
        awake: Schema.Int, perPerson: Schema.Int, monthlyAlertUsd: Schema.Number,
      })))
      yield* Budget.setLimits(limits, "gate-harness").pipe(Effect.provide(database))
      return Option.some(yield* HttpServerResponse.json(limits))
    }
    if (request.method === "GET" && path.startsWith(`${PREFIX}run/`)) {
      const runId = decodeURIComponent(path.slice(`${PREFIX}run/`.length))
      // The stage runs nothing but gates: every run made since this one started is its job or a machine's keep.
      const read = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all({
          runs: sql`SELECT run_id, status, created_at_ms, started_at_ms, finished_at_ms FROM smithers_flows.flows_runs
            WHERE created_at_ms >= (SELECT created_at_ms FROM smithers_flows.flows_runs WHERE run_id = ${runId})
            ORDER BY created_at_ms`,
          attempts: sql`SELECT a.run_id, a.attempt, a.state, a.started_at_ms, a.finished_at_ms, a.outcome_json
            FROM smithers_flows.flows_attempts a JOIN smithers_flows.flows_runs r ON r.run_id = a.run_id
            WHERE r.created_at_ms >= (SELECT created_at_ms FROM smithers_flows.flows_runs WHERE run_id = ${runId})
            ORDER BY a.started_at_ms`,
        })).pipe(Effect.provide(database))
      return Option.some(yield* HttpServerResponse.json(read))
    }
    return Option.some(HttpServerResponse.empty({ status: 404 }))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("gate_harness.request").pipe(Effect.annotateLogs({ cause: String(cause).slice(0, 400) })),
        Option.some(HttpServerResponse.empty({ status: 500 })),
      )
    ),
  )

/** The harness token's SHA-256, set by the stage's deploy; a stage without it answers 404 to every door request. */
const tokenSha256 = Config.String("GATE_HARNESS_TOKEN_SHA256").pipe(Config.withDefault(""))

export default class GateHarness extends Cloudflare.Worker<GateHarness>()(
  "GateHarness",
  { ...props, main: "worker/test/gates/Harness.ts" },
  Effect.gen(function* () {
    const token = yield* Effect.orDie(tokenSha256)
    const loaded = yield* Effect.promise(() => import("../../ChatApiProgram.ts"))
    return yield* loaded.program({ door: door(token) })
  }),
) {}
