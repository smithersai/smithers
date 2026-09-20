import { CLOUD_AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import {
  bindingOf,
  ConfiguredModelSchema,
  failedModelTest,
  MODEL_CREDENTIALS,
  MODEL_TEST_BODY_MAX_BYTES,
  MODEL_TEST_DEADLINE_MS,
  MODEL_TEST_DECISION,
  MODEL_TEST_MAX_TOKENS,
  MODEL_TEST_PROMPT,
  modelSeatsOf,
  ModelTestRequestSchema,
  planModelBinding,
  scrubModelSample,
  servableModels
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelCredentialListing,
  ModelPlan,
  ModelTestFailure,
  ModelTestResult
} from "@smthrs/rpc/ConfiguredModel"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { cloudRoleModel } from "./cloudRoleTurn"
import { ServerConfig } from "./Config"
import type { ServerConfigShape } from "./Config"
import { discardBody, fetchWithDeadline, readBoundedJson } from "./Http"
import type { Transport } from "./Http"
import { JEV_DEFAULT_MODEL, JEV_EVALUATE_URL, jevEvaluate } from "./jev"
import { bodyRefusal, json, refuse } from "./Responses"

/*
 * The Worker's half of the Models surface: GET /api/model/catalog says which
 * models, credential NAMES and seats this deployment serves, and POST
 * /api/model/test makes one real call to a configured model and answers what
 * happened, typed.
 *
 * A credential is a name pinned to origins (@smthrs/rpc/ConfiguredModel). The
 * request names a credential and never carries one, and the planner refuses
 * any address the named credential is not pinned to before a value is read,
 * so a record filed by a prompt-injected agent cannot send the deployment's
 * key anywhere but its provider. This host resolves exactly the two model
 * keys `ServerConfig` holds and reads nothing else by name: every other name
 * is `credential_unknown` here, whatever the environment contains.
 *
 * Those two keys need one wire each: a non-streaming chat completion, built
 * like `cerebrasChat` in recommend.ts, and the evaluation `jev.ts` already
 * speaks. The other protocols are the local host's; here they answer
 * `invalid` naming the protocol. One Test is one request under one deadline,
 * never retried and never redirected, and no provider text but the scrubbed
 * sample is read: a failure is a code and a number, so a key a provider
 * echoes has no field to ride out in.
 */

const MODEL_TEST_SEAM = "model test"

/** The most bytes of a provider's answer this route reads for its sample. */
const ANSWER_MAX_BYTES = 64 * 1024

/** The model keys this deployment holds, by credential name. Closed: a name absent here is never read. */
const WORKER_MODEL_KEYS = {
  CEREBRAS_API_KEY: (config: ServerConfigShape) => config.cerebrasApiKey,
  AI_GATEWAY_API_KEY: (config: ServerConfigShape) => config.aiGatewayApiKey
} as const

type WorkerModelCredentialName = keyof typeof WORKER_MODEL_KEYS

const WORKER_MODEL_CREDENTIAL_NAMES = Object.keys(WORKER_MODEL_KEYS) as ReadonlyArray<WorkerModelCredentialName>

const isWorkerModelCredential = (name: string): name is WorkerModelCredentialName =>
  (WORKER_MODEL_CREDENTIAL_NAMES as ReadonlyArray<string>).includes(name)

/** This host's credential table: the two names, whether each is set, and the origins the contract pins it to. */
export const workerModelCredentials = (config: ServerConfigShape): ReadonlyArray<ModelCredentialListing> =>
  WORKER_MODEL_CREDENTIAL_NAMES.map((name) => ({
    name,
    present: WORKER_MODEL_KEYS[name](config) !== undefined,
    origins: [...(MODEL_CREDENTIALS.find((row) => row.name === name)?.origins ?? [])]
  }))

/** A record id for a provider's model id, or undefined when the id does not fit one. */
const builtinRow = (prefix: string, model: Omit<ConfiguredModel, "id" | "builtin">): ConfiguredModel | undefined => {
  const slug = model.modelId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  const row = ConfiguredModelSchema.safeParse({ ...model, id: `${prefix}${slug}`, builtin: true })
  return row.success ? row.data : undefined
}

/**
 * The models this deployment already serves: the cloud roles' Cerebras models
 * and Jev. A row is listed only when its key is set, so every row is one a
 * Test here can reach.
 */
export const workerBuiltinModels = (config: ServerConfigShape): ReadonlyArray<ConfiguredModel> => {
  const rows = [
    ...CLOUD_AGENT_ROLES.map((role) =>
      builtinRow("cerebras-", {
        protocol: "openai-chat",
        baseUrl: "https://api.cerebras.ai",
        modelId: cloudRoleModel(role, config),
        credential: "CEREBRAS_API_KEY"
      })),
    builtinRow("", { protocol: "evaluation", modelId: JEV_DEFAULT_MODEL, credential: "AI_GATEWAY_API_KEY" })
  ]
  const listed = new Map<string, ConfiguredModel>()
  for (const row of rows) {
    if (row !== undefined) listed.set(row.id, row)
  }
  return servableModels([...listed.values()], workerModelCredentials(config))
}

/** GET /api/model/catalog. The router has already gated the session. Names and presence only, never a value. */
export const handleModelCatalog = (): Effect.Effect<Response, never, ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const catalog: ModelCatalog = {
      models: [...workerBuiltinModels(config)],
      credentials: [...workerModelCredentials(config)],
      seats: [...modelSeatsOf("cloud")],
      enrollment: { available: false, reason: "local_host_required" }
    }
    return json(200, catalog)
  })

type Outcome = { readonly sample: string } | { readonly failure: ModelTestFailure }

const failed = (failure: ModelTestFailure): Outcome => ({ failure })

const UNDECODABLE: Outcome = failed({ code: "invalid", field: "protocol" })
const TIMED_OUT: Outcome = failed({ code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS })
const UNREACHABLE: Outcome = failed({ code: "unreachable" })

/** A provider's status as the refusal it is. A 3xx is one: the redirect was not followed. */
const refused = (status: number): Outcome =>
  status >= 300 && status <= 599 ? failed({ code: "refused", status }) : UNDECODABLE

/** One non-streaming chat completion. The failure's own message is never read: it may quote the request. */
const chatProbe = (plan: ModelPlan, secret: Redacted.Redacted<string>): Effect.Effect<Outcome, never, Transport> =>
  Effect.gen(function*() {
    const response = yield* fetchWithDeadline(MODEL_TEST_SEAM, plan.url, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${Redacted.value(secret)}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: plan.modelId,
        stream: false,
        max_tokens: MODEL_TEST_MAX_TOKENS,
        messages: [{ role: "user", content: MODEL_TEST_PROMPT }]
      })
    }, MODEL_TEST_DEADLINE_MS)
    if (!response.ok) {
      yield* discardBody(response)
      return refused(response.status)
    }
    const body = (yield* readBoundedJson(response, ANSWER_MAX_BYTES).pipe(Effect.catch(() => Effect.succeed(undefined)))) as
      | { readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } } | null> }
      | null
      | undefined
    const content = Array.isArray(body?.choices) ? body.choices[0]?.message?.content : undefined
    return typeof content === "string" ? { sample: scrubModelSample(content, Redacted.value(secret)) } : UNDECODABLE
  }).pipe(
    Effect.catchTag("UpstreamTimeout", () => Effect.succeed(TIMED_OUT)),
    Effect.catchTag("UpstreamUnreachable", () => Effect.succeed(UNREACHABLE))
  )

/**
 * One evaluation through the client every decision here already uses. That
 * client speaks to one address with one key, so a plan that resolved anywhere
 * else is refused rather than answered from somewhere the record did not name.
 */
const decisionProbe = (plan: ModelPlan): Effect.Effect<Outcome, never, Transport | ServerConfig> =>
  plan.url !== JEV_EVALUATE_URL
    ? Effect.succeed(failed({ code: "invalid", field: "baseUrl" }))
    : Effect.map(
      jevEvaluate({ model: plan.modelId, state: MODEL_TEST_DECISION.state, questions: MODEL_TEST_DECISION.questions }, MODEL_TEST_DEADLINE_MS),
      (answer): Outcome => {
        if (!answer.ok) {
          switch (answer.reason) {
            case "http":
              return refused(answer.status)
            case "timeout":
              return TIMED_OUT
            case "unreachable":
              return UNREACHABLE
            case "empty":
              return UNDECODABLE
          }
        }
        const ok = answer.answers["ok"]
        return ok?.type === "boolean" && typeof ok.probability === "number" && Number.isFinite(ok.probability)
          ? { sample: `${ok.probability >= 0.5} ${ok.probability.toFixed(2)}` }
          : UNDECODABLE
      }
    )

const probe = (model: ConfiguredModel): Effect.Effect<Outcome, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const planned = planModelBinding(bindingOf(model), workerModelCredentials(config))
    if (!planned.ok) return failed(planned.failure)
    const { plan } = planned
    // This host's chat wire is Cerebras's. The gateway key buys evaluations only, so it is never read for a completion.
    if (plan.protocol === "openai-chat" && plan.credential !== "CEREBRAS_API_KEY") return failed({ code: "model_not_allowed" })
    // The planner admitted the name from this host's own table, and found it set.
    const secret = isWorkerModelCredential(plan.credential) ? WORKER_MODEL_KEYS[plan.credential](config) : undefined
    if (secret === undefined) return failed({ code: "credential_missing", credential: plan.credential })
    switch (plan.protocol) {
      case "evaluation":
        return yield* decisionProbe(plan)
      case "openai-chat":
        return yield* chatProbe(plan, secret)
      // No key this host holds speaks these wires.
      case "anthropic-messages":
      case "openai-responses":
        return UNDECODABLE
    }
  }).pipe(Effect.timeoutOrElse({ duration: MODEL_TEST_DEADLINE_MS, orElse: () => Effect.succeed(TIMED_OUT) }))

/**
 * POST /api/model/test. The router has already gated the session and spent
 * the login's budget. A Test that ran answers 200 whatever it found; only a
 * body this route will not run is a refusal.
 */
export const handleModelTest = (request: Request): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const body = yield* readBoundedJson(request, MODEL_TEST_BODY_MAX_BYTES).pipe(
      Effect.catch((failure) => Effect.succeed(bodyRefusal(failure)))
    )
    if (body instanceof Response) return body
    const parsed = ModelTestRequestSchema.safeParse(body)
    if (!parsed.success) return refuse("request_invalid", "Body must be { model }.")
    const started = yield* Clock.currentTimeMillis
    const outcome = yield* probe(parsed.data.model)
    const latencyMs = Math.max(0, Math.round((yield* Clock.currentTimeMillis) - started))
    const result: ModelTestResult = "sample" in outcome
      ? { ok: true, latencyMs, sample: outcome.sample }
      : failedModelTest(outcome.failure, latencyMs, "cloud")
    return json(200, result)
  })
