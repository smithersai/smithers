import { CLOUD_AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import {
  bindingOf,
  ConfiguredModelSchema,
  cutModelCredential,
  decodeModelAnswers,
  failedModelTest,
  MODEL_CALL_TEXT_MAX,
  MODEL_TEST_BODY_MAX_BYTES,
  MODEL_TEST_DEADLINE_MS,
  modelCallDefault,
  modelCallSample,
  modelSeatsOf,
  modelStateOf,
  ModelTestRequestSchema,
  planModelBinding,
  servableModels
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelCallInput,
  ModelCallOutput,
  ModelCatalog,
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
import { accountModelCall } from "./accountModelCall"
import { deploymentModelSecret, isDeploymentCredential as isWorkerModelCredential, workerModelCredentials } from "./modelVault"
import type { AccountCredentials } from "./modelVault"
export { workerModelCredentials } from "./modelVault"

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
 * keys `ServerConfig` holds, plus the authenticated account vault. Undeclared
 * names are unknown; an account failure never selects a deployment key.
 *
 * Those two keys need one wire each: a non-streaming chat completion, built
 * like `cerebrasChat` in recommend.ts, and the evaluation `jev.ts` already
 * speaks. Account credentials use `accountModelCall` for all four protocol
 * wires, on the account's immutable pin. The request is the fixed Test unless the
 * caller composed one (the model-call card). One Test is one request under
 * one deadline, never retried and never redirected, and no provider text but
 * the generated words, with the key cut out, is read: a failure is a code
 * and a number, so a key a provider echoes has no field to ride out in.
 */

const MODEL_TEST_SEAM = "model test"

/** The most bytes of a provider's answer this route reads for its sample. */
const ANSWER_MAX_BYTES = 64 * 1024

/**
 * A Test proves the key, the address and the wire, and a person is watching
 * the latency it reports. The Cerebras default reasons at `high` when the
 * body says nothing, which would spend the whole answer budget and most of
 * the deadline before a word arrives. `low`, not `none`: the probe tests any
 * Cerebras model id, and gpt-oss-120b accepts only low, medium and high.
 */
const MODEL_TEST_REASONING_EFFORT = "low" as const

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

/** Public deployment metadata plus the optional validated account listing. Never a value. */
export const handleModelCatalog = (account?: AccountCredentials, signedIn = true): Effect.Effect<Response, never, ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const catalog: ModelCatalog = {
      models: [...workerBuiltinModels(config)],
      credentials: [...workerModelCredentials(config), ...(account?.listings ?? [])],
      seats: [...modelSeatsOf("cloud")],
      enrollment: !signedIn ? { available: false, reason: "sign_in_required" } : account?.available ? { available: true } : { available: false, reason: "vault_unavailable" }
    }
    const response = json(200, catalog)
    response.headers.set("cache-control", "no-store")
    return response
  })

type Outcome = { readonly output: ModelCallOutput } | { readonly failure: ModelTestFailure }

const failed = (failure: ModelTestFailure): Outcome => ({ failure })

const UNDECODABLE: Outcome = failed({ code: "invalid", field: "protocol" })
const TIMED_OUT: Outcome = failed({ code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS })
const UNREACHABLE: Outcome = failed({ code: "unreachable" })

/** A provider's status as the refusal it is. A 3xx is one: the redirect was not followed. */
const refused = (status: number): Outcome =>
  status >= 300 && status <= 599 ? failed({ code: "refused", status }) : UNDECODABLE

/** One non-streaming chat completion. The failure's own message is never read: it may quote the request. */
const chatProbe = (
  plan: ModelPlan,
  secret: Redacted.Redacted<string>,
  input: Extract<ModelCallInput, { kind: "generation" }>
): Effect.Effect<Outcome, never, Transport> =>
  Effect.gen(function*() {
    const response = yield* fetchWithDeadline(MODEL_TEST_SEAM, plan.url, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${Redacted.value(secret)}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: plan.modelId,
        stream: false,
        max_tokens: input.maxTokens,
        reasoning_effort: MODEL_TEST_REASONING_EFFORT,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        messages: [
          ...(input.system.trim() === "" ? [] : [{ role: "system", content: input.system }]),
          { role: "user", content: input.prompt }
        ]
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
    if (typeof content !== "string") return UNDECODABLE
    const output: ModelCallOutput = { kind: "generation", text: cutModelCredential(content, Redacted.value(secret)).slice(0, MODEL_CALL_TEXT_MAX) }
    return { output }
  }).pipe(
    Effect.catchTag("UpstreamTimeout", () => Effect.succeed(TIMED_OUT)),
    Effect.catchTag("UpstreamUnreachable", () => Effect.succeed(UNREACHABLE))
  )

/**
 * One evaluation through the client every decision here already uses. That
 * client speaks to one address with one key, so a plan that resolved anywhere
 * else is refused rather than answered from somewhere the record did not name.
 */
const decisionProbe = (
  plan: ModelPlan,
  input: Extract<ModelCallInput, { kind: "decision" }>
): Effect.Effect<Outcome, never, Transport | ServerConfig> =>
  plan.url !== JEV_EVALUATE_URL
    ? Effect.succeed(failed({ code: "invalid", field: "baseUrl" }))
    : Effect.map(
      jevEvaluate({ model: plan.modelId, state: modelStateOf(input.state), questions: input.questions }, MODEL_TEST_DEADLINE_MS),
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
        // Decoded against the questions asked, as the classifier decodes on the local host: an answer that fits no question is the protocol's failure.
        const decoded = decodeModelAnswers(input.questions, answer.answers)
        return decoded.ok ? { output: { kind: "decision", answers: decoded.answers } } : UNDECODABLE
      }
    )

const probe = (model: ConfiguredModel, input: ModelCallInput | undefined): Effect.Effect<Outcome, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const planned = planModelBinding(bindingOf(model), workerModelCredentials(config))
    if (!planned.ok) return failed(planned.failure)
    const { plan } = planned
    const request = input ?? modelCallDefault(plan.kind)
    // A prompt for a decision model, or questions for a generation model, fit no wire the record speaks.
    if (request.kind !== plan.kind) return UNDECODABLE
    // This host's chat wire is Cerebras's. The gateway key buys evaluations only, so it is never read for a completion.
    if (plan.protocol === "openai-chat" && plan.credential !== "CEREBRAS_API_KEY") return failed({ code: "model_not_allowed" })
    // The planner admitted the name from this host's own table, and found it set.
    const secret = deploymentModelSecret(config, plan.credential)
    if (secret === undefined) return failed({ code: "credential_missing", credential: plan.credential })
    switch (request.kind) {
      case "decision":
        return yield* decisionProbe(plan, request)
      case "generation":
        return plan.protocol === "openai-chat" ? yield* chatProbe(plan, secret, request) : UNDECODABLE
    }
  }).pipe(Effect.timeoutOrElse({ duration: MODEL_TEST_DEADLINE_MS, orElse: () => Effect.succeed(TIMED_OUT) }))


/**
 * POST /api/model/test. The router has already gated the session and spent
 * the login's budget. A Test that ran answers 200 whatever it found; only a
 * body this route will not run is a refusal.
 */
export const handleModelTest = (request: Request, account?: AccountCredentials): Effect.Effect<Response, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const body = yield* readBoundedJson(request, MODEL_TEST_BODY_MAX_BYTES).pipe(
      Effect.catch((failure) => Effect.succeed(bodyRefusal(failure)))
    )
    if (body instanceof Response) return body
    const parsed = ModelTestRequestSchema.safeParse(body)
    if (!parsed.success) return refuse("request_invalid", "Body must be { model }.")
    const started = yield* Clock.currentTimeMillis
    const config = yield* ServerConfig
    const outcome = yield* (!isWorkerModelCredential(parsed.data.model.credential) && account
      ? accountModelCall(bindingOf(parsed.data.model), parsed.data.input, account)
      : probe(parsed.data.model, parsed.data.input))
    if (outcome instanceof Response) return outcome
    const latencyMs = Math.max(0, Math.round((yield* Clock.currentTimeMillis) - started))
    // The sample is cut with this deployment's key for the record's name; the words were already cut when read.
    const secret = deploymentModelSecret(config, parsed.data.model.credential)
    const result: ModelTestResult = "output" in outcome
      ? outcome.output.kind === "generation" && outcome.output.text.trim() === ""
        ? failedModelTest({ code: "empty_output" }, latencyMs, "cloud")
        : { ok: true, latencyMs, sample: modelCallSample(outcome.output, secret === undefined ? "" : Redacted.value(secret)), output: outcome.output }
      : failedModelTest(outcome.failure, latencyMs, "cloud")
    return json(200, result)
  })
