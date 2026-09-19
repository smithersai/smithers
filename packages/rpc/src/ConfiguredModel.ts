/**
 * Configured models: the record a person saves, the credential NAME it spends,
 * the origins that name may travel to, the seats a model answers for, and the
 * typed result of testing one.
 *
 * A credential is a name pinned to origins. Agent parity means a
 * prompt-injected agent can file any record a person can, so a free endpoint
 * beside a named key would be key exfiltration: `{ credential:
 * "CEREBRAS_API_KEY", baseUrl: "https://attacker" }`. No request body can
 * introduce an origin. A built-in name travels only to the https origins this
 * file lists for it; a custom name exists only where the operator of a host
 * declared the environment pair `SMITHERS_MODEL_KEY_<NAME>` and
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`, and travels only there. The mandatory
 * prefix is why no route can be talked into reading an arbitrary variable.
 *
 * Everything here is pure and holds no value: a host reads the secret itself,
 * after {@link planModelBinding} has said where it may go.
 *
 * @since 1.0.0
 */
import { z } from "zod"
import { ModelIdSchema } from "./AgentRoles.ts"
import { PLUE_FAULTS } from "./PlueFailureCodes.ts"
import type { PlueFault } from "./PlueFailureCodes.ts"
import type { WorkerFailureCode } from "./WorkerFailureCodes.ts"

/**
 * The wire a configured model speaks, one per provider protocol family.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-chat", "evaluation"] as const
/**
 * Validates a model protocol at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelProtocolSchema = z.enum(MODEL_PROTOCOLS)
/**
 * The decoded value accepted by {@link ModelProtocolSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>

/**
 * What a model is asked for: text, or a calibrated answer to a closed question.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_KINDS = ["generation", "decision"] as const
/**
 * What a model is asked for.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelKind = (typeof MODEL_KINDS)[number]
/**
 * The kind a protocol serves. A record stores no kind, so the two cannot disagree.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelKindOf = (protocol: ModelProtocol): ModelKind => protocol === "evaluation" ? "decision" : "generation"

/**
 * The host answering: the desktop app's own Bun host, or the Cloudflare Worker.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelHost = "local" | "cloud"

/**
 * Each protocol's default base URL and fixed path. Only `openai-chat` has no
 * default origin and honours a record's own `path`.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_PROTOCOL_DEFAULTS: Readonly<
  Record<ModelProtocol, { readonly baseUrl: string | undefined; readonly path: string }>
> = {
  "anthropic-messages": { baseUrl: "https://api.anthropic.com", path: "/v1/messages" },
  "openai-responses": { baseUrl: "https://api.openai.com", path: "/v1/responses" },
  "openai-chat": { baseUrl: undefined, path: "/v1/chat/completions" },
  evaluation: { baseUrl: "https://ai-gateway.vercel.sh", path: "/v4/ai/evaluation-model" }
}

/**
 * The word that returns a seat to its host where a model's name would stand:
 * `model.assign <seat> default`, and the seat select's first option.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEAT_DEFAULT = "default"
/**
 * A configured model's name, which is also its id: the slug a person types.
 * Never {@link MODEL_SEAT_DEFAULT}, which a seat reads as "no model".
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_RECORD_ID = /^(?!default$)[a-z][a-z0-9-]{0,39}$/
/**
 * Validates a configured model's name at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelRecordIdSchema = z.string().regex(
  MODEL_RECORD_ID,
  "a model name is lowercase letters, digits and dashes, starting with a letter"
)
/**
 * The decoded value accepted by {@link ModelRecordIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelRecordId = z.infer<typeof ModelRecordIdSchema>

/**
 * A credential NAME: upper snake case, and never one ending in `ORIGIN`, which
 * is how a custom credential's origin declaration is spelled.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_NAME = /^(?!(?:.*_)?ORIGIN$)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
/**
 * Validates a credential name at the RPC boundary. A name, never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialNameSchema = z.string().min(2).max(63).regex(
  MODEL_CREDENTIAL_NAME,
  "a credential is an upper-case name such as OPENAI_API_KEY"
)
/**
 * The decoded value accepted by {@link ModelCredentialNameSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialName = z.infer<typeof ModelCredentialNameSchema>

/**
 * The built-in credentials and the ONLY origins each may be sent to. A host
 * reads a built-in from the environment name it is spelled by.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIALS = [
  { name: "ANTHROPIC_API_KEY", origins: ["https://api.anthropic.com"] },
  { name: "OPENAI_API_KEY", origins: ["https://api.openai.com"] },
  { name: "CEREBRAS_API_KEY", origins: ["https://api.cerebras.ai"] },
  { name: "OPENROUTER_API_KEY", origins: ["https://openrouter.ai"] },
  { name: "AI_GATEWAY_API_KEY", origins: ["https://ai-gateway.vercel.sh"] }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly origins: ReadonlyArray<string> }>
/**
 * The name of a built-in credential.
 *
 * @since 1.0.0
 * @category models
 */
export type BuiltinModelCredentialName = (typeof MODEL_CREDENTIALS)[number]["name"]
/**
 * Whether a name is one of the built-in credentials.
 *
 * @since 1.0.0
 * @category guards
 */
export const isBuiltinModelCredential = (name: string): name is BuiltinModelCredentialName =>
  MODEL_CREDENTIALS.some((row) => row.name === name)

/**
 * The mandatory prefix of a custom credential's environment variable:
 * `SMITHERS_MODEL_KEY_<NAME>` holds the value.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_ENV_PREFIX = "SMITHERS_MODEL_KEY_"
/**
 * The suffix of the variable declaring a custom credential's one origin:
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_ORIGIN_SUFFIX = "_ORIGIN"

/**
 * An environment as a host hands it over: names to values, read by name only.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialEnv = Readonly<Record<string, string | undefined>>

/**
 * The one environment variable a credential's value may be read from: the
 * standard name for a built-in, the prefixed name for everything else.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelCredentialEnvName = (name: string): string =>
  isBuiltinModelCredential(name) ? name : `${MODEL_CREDENTIAL_ENV_PREFIX}${name}`

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)

/**
 * An origin in canonical form, or undefined when a credential may never travel
 * there: https to any host, `http:` to a loopback host only, and no userinfo,
 * query or fragment.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelOriginOf = (value: string | undefined): string | undefined => {
  let url: URL
  try {
    url = new URL(value ?? "")
  } catch {
    return undefined
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined
  if (url.protocol === "https:") return url.origin
  return url.protocol === "http:" && isLoopbackHost(url.hostname) ? url.origin : undefined
}
/**
 * Whether a canonical origin is on this machine.
 *
 * @since 1.0.0
 * @category guards
 */
export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * The custom credentials an operator declared: every
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN` whose value is an origin a credential may
 * travel to. An unprefixed variable is never read, and a pair spelled with a
 * built-in's name declares nothing, so a built-in can never be re-pinned.
 *
 * @since 1.0.0
 * @category conversions
 */
export const customModelCredentials = (
  env: ModelCredentialEnv
): ReadonlyArray<{ readonly name: string; readonly origin: string }> =>
  Object.keys(env).sort().flatMap((key) => {
    if (!key.startsWith(MODEL_CREDENTIAL_ENV_PREFIX) || !key.endsWith(MODEL_CREDENTIAL_ORIGIN_SUFFIX)) return []
    const name = key.slice(MODEL_CREDENTIAL_ENV_PREFIX.length, -MODEL_CREDENTIAL_ORIGIN_SUFFIX.length)
    if (!ModelCredentialNameSchema.safeParse(name).success || isBuiltinModelCredential(name)) return []
    const origin = modelOriginOf(env[key])
    return origin === undefined ? [] : [{ name, origin }]
  })

/**
 * Validates one credential a host resolves: its name, whether a value is set,
 * and the origins it may travel to. No value exists on this wire.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialListingSchema = z.strictObject({
  name: ModelCredentialNameSchema,
  present: z.boolean(),
  origins: z.array(z.string().max(512)).max(8)
})
/**
 * The decoded value accepted by {@link ModelCredentialListingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialListing = z.infer<typeof ModelCredentialListingSchema>

/**
 * The credential table of a host that reads its environment: the built-ins,
 * then the operator's declared pairs. Only presence leaves this function.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hostModelCredentials = (env: ModelCredentialEnv): ReadonlyArray<ModelCredentialListing> => {
  const present = (name: string): boolean => (env[modelCredentialEnvName(name)] ?? "").trim() !== ""
  return [
    ...MODEL_CREDENTIALS.map((row) => ({ name: row.name, present: present(row.name), origins: [...row.origins] })),
    ...customModelCredentials(env).map((row) => ({ name: row.name, present: present(row.name), origins: [row.origin] }))
  ]
}

const modelShape = {
  protocol: ModelProtocolSchema,
  /** Absent means the protocol's default. Its origin must be one the credential is pinned to. */
  baseUrl: z.string().min(1).max(512).regex(/^\S+$/).optional(),
  /** Honoured for `openai-chat` only. */
  path: z.string().min(1).max(256).regex(/^\S+$/).optional(),
  /** The provider's model id, verbatim. */
  modelId: ModelIdSchema,
  credential: ModelCredentialNameSchema
}

/**
 * Validates a configured model. Flat, because a form renders one field per
 * property and no unions; the name is the id, so renaming saves a copy.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ConfiguredModelSchema = z.strictObject({
  id: ModelRecordIdSchema,
  ...modelShape,
  /** True only on a row the host reported. */
  builtin: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link ConfiguredModelSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>

/**
 * Validates what a turn or a decision request carries to be answered on a
 * configured model: the record without its name. Never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelBindingSchema = z.strictObject(modelShape)
/**
 * The decoded value accepted by {@link ModelBindingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelBinding = z.infer<typeof ModelBindingSchema>
/**
 * The binding a record rides a request as.
 *
 * @since 1.0.0
 * @category conversions
 */
export const bindingOf = (model: ConfiguredModel): ModelBinding => ({
  protocol: model.protocol,
  ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
  ...(model.path === undefined ? {} : { path: model.path }),
  modelId: model.modelId,
  credential: model.credential
})

/**
 * The evaluation models a deployment key may be spent on. The form's select,
 * the planner and the Worker all read this tuple.
 *
 * @since 1.0.0
 * @category constants
 */
export const DECISION_MODEL_IDS = ["typesafe-ai/jev"] as const
/**
 * Validates an allowlisted decision model id at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const DecisionModelIdSchema = z.enum(DECISION_MODEL_IDS)
/**
 * The decoded value accepted by {@link DecisionModelIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type DecisionModelId = z.infer<typeof DecisionModelIdSchema>

/**
 * The seat ids, closed: a seat exists only while something reads it.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEAT_IDS = ["explainer", "front-door", "recommend"] as const
/**
 * Validates a seat id at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeatIdSchema = z.enum(MODEL_SEAT_IDS)
/**
 * The decoded value accepted by {@link SeatIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SeatId = z.infer<typeof SeatIdSchema>

/**
 * One seat: the kind of model it takes and the hosts that read it.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelSeat {
  readonly id: SeatId
  readonly label: string
  readonly kind: ModelKind
  readonly hosts: ReadonlyArray<ModelHost>
}
/**
 * The seats, each with a live reader: `explainer` is the sealed `agent.explain`
 * side turn, `front-door` and `recommend` are the Worker's two decision sites.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEATS = [
  { id: "explainer", label: "Explainer", kind: "generation", hosts: ["local", "cloud"] },
  { id: "front-door", label: "Front door", kind: "decision", hosts: ["cloud"] },
  { id: "recommend", label: "Recommendations", kind: "decision", hosts: ["cloud"] }
] as const satisfies ReadonlyArray<ModelSeat>
/**
 * One seat's row.
 *
 * @since 1.0.0
 * @category accessors
 */
export const modelSeat = (id: SeatId): ModelSeat => MODEL_SEATS.find((seat) => seat.id === id) ?? MODEL_SEATS[0]
/**
 * The seat ids a host resolves, which is what its catalog lists.
 *
 * @since 1.0.0
 * @category accessors
 */
export const modelSeatsOf = (host: ModelHost): ReadonlyArray<SeatId> =>
  MODEL_SEATS.filter((seat) => (seat.hosts as ReadonlyArray<ModelHost>).includes(host)).map((seat) => seat.id)
/**
 * The one rule the assign flow, the reducer and the consumers share: a seat
 * takes only a model of its kind.
 *
 * @since 1.0.0
 * @category guards
 */
export const seatAccepts = (seat: SeatId, protocol: ModelProtocol): boolean =>
  modelSeat(seat).kind === modelKindOf(protocol)

/**
 * Validates a seat assignment. The row key is the seat: one model per seat,
 * and an unassigned seat has no row.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeatAssignmentSchema = z.strictObject({ id: SeatIdSchema, recordId: ModelRecordIdSchema })
/**
 * The decoded value accepted by {@link SeatAssignmentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SeatAssignment = z.infer<typeof SeatAssignmentSchema>

/**
 * The one deadline a test runs under, headers and body. A timeout failure
 * echoes it as `deadlineMs`, and that record is what an interface reads.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_DEADLINE_MS = 15_000
/**
 * The ceiling of a test request body.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_BODY_MAX_BYTES = 8 * 1024
/**
 * The output a generation test asks for, in tokens.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_MAX_TOKENS = 32
/**
 * The ceiling of the sample a passed test returns, in characters.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_SAMPLE_MAX = 80
/**
 * The one message a generation test sends.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_PROMPT = "Reply with the single word: ok"
/**
 * The one question a decision test asks.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_DECISION = {
  state: { text: "The sky is blue." },
  questions: { ok: { type: "boolean", instructions: "Does the text mention a color?" } }
} as const

/**
 * Validates a test request: the whole record, so a draft can be tested before it is saved.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestRequestSchema = z.strictObject({ model: ConfiguredModelSchema })
/**
 * The decoded value accepted by {@link ModelTestRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestRequest = z.infer<typeof ModelTestRequestSchema>

/**
 * The record fields an `invalid` failure may name; `model` is the record as a whole.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_INVALID_FIELDS = ["model", "protocol", "baseUrl", "path", "modelId", "credential"] as const
/**
 * A record field an `invalid` failure names.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelInvalidField = (typeof MODEL_INVALID_FIELDS)[number]

/**
 * Every way a configured model fails, by code.
 *
 * - `unreachable` no answer came back from the endpoint.
 * - `refused` the endpoint answered with this status; a redirect is never followed, so a 3xx is one.
 * - `timeout` the deadline the failure states ran out.
 * - `invalid` the named field cannot be served, or the endpoint does not speak the protocol.
 * - `credential_missing` the host lists the name and holds no value for it.
 * - `credential_unknown` the host does not list the name.
 * - `endpoint_forbidden` the credential is not pinned to the base URL's origin.
 * - `model_not_allowed` a deployment key was asked for a decision model off {@link DECISION_MODEL_IDS}.
 * - `host_refused` the host itself refused or never answered; written by the client, never by a host.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_FAILURE_CODES = [
  "unreachable",
  "refused",
  "timeout",
  "invalid",
  "credential_missing",
  "credential_unknown",
  "endpoint_forbidden",
  "model_not_allowed",
  "host_refused"
] as const

/** A refusal registry code's alphabet, so the one string a client writes into a failure is never prose. */
const HOST_REFUSAL_CODE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

/**
 * Validates a model failure. Codes, numbers, enums and the echoed credential
 * NAME only: no branch has a field a provider's words, a URL or a key could
 * ride in, and every branch is strict.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("unreachable") }),
  z.strictObject({ code: z.literal("refused"), status: z.number().int().min(300).max(599) }),
  z.strictObject({ code: z.literal("timeout"), deadlineMs: z.number().int().positive() }),
  z.strictObject({ code: z.literal("invalid"), field: z.enum(MODEL_INVALID_FIELDS) }),
  z.strictObject({ code: z.literal("credential_missing"), credential: ModelCredentialNameSchema }),
  z.strictObject({ code: z.literal("credential_unknown"), credential: ModelCredentialNameSchema }),
  z.strictObject({ code: z.literal("endpoint_forbidden") }),
  z.strictObject({ code: z.literal("model_not_allowed") }),
  z.strictObject({
    code: z.literal("host_refused"),
    /** The refusal's registry code (Refusal.ts), null when it carried none. */
    refusal: z.string().regex(HOST_REFUSAL_CODE).nullable(),
    /** Null when no response came back at all. */
    status: z.number().int().min(100).max(599).nullable(),
    /** The refusal's own fault: the registry judged it, this union does not. */
    fault: z.enum(PLUE_FAULTS)
  })
])
/**
 * The decoded value accepted by {@link ModelTestFailureSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestFailure = z.infer<typeof ModelTestFailureSchema>

/**
 * Whose problem a model failure is. An exhaustive switch, so a new code does
 * not compile until it has a fault. An unset key is the reader's own on their
 * machine and the deployment's on the Worker.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelFailureFault = (failure: ModelTestFailure, host: ModelHost): PlueFault => {
  switch (failure.code) {
    case "unreachable":
      return "dependency"
    case "timeout":
      return "dependency"
    case "refused":
      return failure.status === 429 ? "wait" : failure.status >= 500 ? "dependency" : "user"
    case "invalid":
      return "user"
    case "credential_unknown":
      return "user"
    case "endpoint_forbidden":
      return "user"
    case "model_not_allowed":
      return "user"
    case "credential_missing":
      return host === "cloud" ? "infra" : "user"
    case "host_refused":
      return failure.fault
  }
}

/**
 * The Worker-vocabulary code a host refuses a TURN with when its model binding
 * fails. The test route never uses it: a test answers 200 with the failure.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelFailureRefusalCode = (failure: ModelTestFailure): WorkerFailureCode => {
  switch (failure.code) {
    case "invalid":
    case "credential_unknown":
    case "endpoint_forbidden":
    case "model_not_allowed":
      return "request_invalid"
    case "credential_missing":
      return "seam_not_configured"
    case "unreachable":
      return "upstream_unreachable"
    case "timeout":
      return "upstream_timeout"
    case "refused":
      return failure.status === 429 ? "model_rate_limited" : "upstream_refused"
    case "host_refused":
      return "unexpected_failure"
  }
}

/**
 * Validates a test's answer. Both outcomes are an HTTP 200: a failed test is
 * an answer, and only a refusal to run one uses the refusal envelopes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    latencyMs: z.number().int().nonnegative(),
    /** The model's own words, scrubbed and cut by {@link scrubModelSample}. */
    sample: z.string().max(MODEL_TEST_SAMPLE_MAX)
  }),
  z.strictObject({
    ok: z.literal(false),
    latencyMs: z.number().int().nonnegative(),
    failure: ModelTestFailureSchema,
    fault: z.enum(PLUE_FAULTS)
  })
])
/**
 * The decoded value accepted by {@link ModelTestResultSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>

/**
 * A failed result whose fault is looked up, never chosen at the call site.
 *
 * @since 1.0.0
 * @category conversions
 */
export const failedModelTest = (failure: ModelTestFailure, latencyMs: number, host: ModelHost): ModelTestResult => ({
  ok: false,
  latencyMs: Math.max(0, Math.round(latencyMs)),
  failure,
  fault: modelFailureFault(failure, host)
})

/**
 * The result a CLIENT stores when the host refused to run the test or never
 * answered: the refusal's registry code, status and fault (Refusal.ts), and
 * never its message.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hostRefusedModelTest = (
  refusal: { readonly code: string | null; readonly status: number | null; readonly fault: PlueFault },
  latencyMs: number
): Extract<ModelTestResult, { ok: false }> => {
  const code = refusal.code !== null && HOST_REFUSAL_CODE.test(refusal.code) ? refusal.code : null
  const status = refusal.status !== null && Number.isInteger(refusal.status) && refusal.status >= 100 &&
      refusal.status <= 599 ?
    refusal.status :
    null
  return {
    ok: false,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    failure: { code: "host_refused", refusal: code, status, fault: refusal.fault },
    fault: refusal.fault
  }
}

/**
 * Provider text with a credential's value cut out of it. Model output is
 * attacker-controlled on a custom endpoint, so every host cuts an echoed key
 * with this one rule, in a Test's sample and in a turn's text alike.
 *
 * @since 1.0.0
 * @category conversions
 */
export const cutModelCredential = (text: string, secret: string): string => {
  let kept = text
  // Again until none is left: cutting one echo out can join the halves of another.
  while (secret !== "" && kept.includes(secret)) kept = kept.split(secret).join("")
  return kept
}

/**
 * A sample fit to leave a host: the echoed key is cut out before anything
 * else happens.
 *
 * @since 1.0.0
 * @category conversions
 */
export const scrubModelSample = (text: string, secret: string): string =>
  cutModelCredential(text, secret).replace(/\s+/g, " ").trim().slice(0, MODEL_TEST_SAMPLE_MAX)

/**
 * Where a model's requests go, once its credential allowed it.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolvedModelEndpoint {
  readonly origin: string
  /** Canonical, with no trailing slash. */
  readonly baseUrl: string
  readonly path: string
  readonly url: string
}

/**
 * What a host that cannot leave the machine passes: `egress: false` admits loopback only.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelEndpointOptions {
  readonly egress?: boolean
}

const failed = (failure: ModelTestFailure) => ({ ok: false, failure }) as const

const pathIsSafe = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//") && !/[?#\\]/.test(path) &&
  !path.split("/").some((segment) => segment === "." || segment === ".." || /%2e/i.test(segment))

/**
 * The one rule that decides where a credential may travel. `credentials` is
 * the HOST's table, never the request's: the base URL's origin must be one the
 * named credential is pinned to, or the answer is `endpoint_forbidden`.
 *
 * @since 1.0.0
 * @category conversions
 */
export const resolveModelEndpoint = (
  model: Pick<ConfiguredModel, "protocol" | "baseUrl" | "path" | "credential">,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelEndpointOptions = {}
): { readonly ok: true; readonly endpoint: ResolvedModelEndpoint } | {
  readonly ok: false
  readonly failure: ModelTestFailure
} => {
  const credential = credentials.find((row) => row.name === model.credential)
  if (credential === undefined) return failed({ code: "credential_unknown", credential: model.credential })
  const defaults = MODEL_PROTOCOL_DEFAULTS[model.protocol]
  const raw = model.baseUrl ?? defaults.baseUrl
  if (raw === undefined) return failed({ code: "invalid", field: "baseUrl" })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return failed({ code: "invalid", field: "baseUrl" })
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return failed({ code: "invalid", field: "baseUrl" })
  }
  // Canonicalised again here, so a table cannot admit what a declaration could not.
  const origin = modelOriginOf(url.origin)
  if (origin === undefined || !credential.origins.includes(origin)) return failed({ code: "endpoint_forbidden" })
  if (options.egress === false && !isLoopbackOrigin(origin)) return failed({ code: "endpoint_forbidden" })
  if (model.protocol !== "openai-chat" && model.path !== undefined && model.path !== defaults.path) {
    return failed({ code: "invalid", field: "path" })
  }
  const path = model.path ?? defaults.path
  if (!pathIsSafe(path)) return failed({ code: "invalid", field: "path" })
  const baseUrl = url.toString().replace(/\/+$/, "")
  const target = `${baseUrl}${path}`
  if (modelOriginOf(new URL(target).origin) !== origin) return failed({ code: "invalid", field: "path" })
  return { ok: true, endpoint: { origin, baseUrl, path, url: target } }
}

/**
 * A binding a host has agreed to serve: a credential NAME and an address,
 * never a value. The host reads the secret by that name afterwards.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelPlan extends ResolvedModelEndpoint {
  readonly kind: ModelKind
  readonly protocol: ModelProtocol
  readonly modelId: string
  readonly credential: string
}

/**
 * What the caller requires of a binding: the kind its seat takes, and whether this host has egress.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelPlanOptions extends ModelEndpointOptions {
  readonly kind?: ModelKind
}

/**
 * A plan, or the typed reason there is none.
 *
 * @since 1.0.0
 * @category models
 */
export type PlannedModel =
  | { readonly ok: true; readonly plan: ModelPlan }
  | { readonly ok: false; readonly failure: ModelTestFailure }

/**
 * An untrusted binding and a host's credential table in; a credential-free
 * plan or a typed failure out. Pure: no I/O, no value. Where a credential may
 * go is judged before whether it is set, so an unset key never excuses a
 * foreign origin. The decision allowlist binds the built-in credentials, which
 * are deployment keys; an operator's own endpoint names its own models.
 *
 * @since 1.0.0
 * @category conversions
 */
export const planModelBinding = (
  input: unknown,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelPlanOptions = {}
): PlannedModel => {
  const parsed = ModelBindingSchema.safeParse(input)
  if (!parsed.success) {
    const named = parsed.error.issues[0]?.path[0]
    const field = MODEL_INVALID_FIELDS.find((candidate) => candidate === named) ?? "model"
    return failed({ code: "invalid", field })
  }
  const binding = parsed.data
  const kind = modelKindOf(binding.protocol)
  if (options.kind !== undefined && options.kind !== kind) return failed({ code: "invalid", field: "protocol" })
  const resolved = resolveModelEndpoint(binding, credentials, options)
  if (!resolved.ok) return resolved
  if (
    kind === "decision" && isBuiltinModelCredential(binding.credential) &&
    !DecisionModelIdSchema.safeParse(binding.modelId).success
  ) {
    return failed({ code: "model_not_allowed" })
  }
  if (credentials.find((row) => row.name === binding.credential)?.present !== true) {
    return failed({ code: "credential_missing", credential: binding.credential })
  }
  return {
    ok: true,
    plan: {
      kind,
      protocol: binding.protocol,
      modelId: binding.modelId,
      credential: binding.credential,
      ...resolved.endpoint
    }
  }
}

/**
 * The rows of a host's built-in list that host can serve: a row is listed only
 * when a Test of it there would plan, so its key is set and its endpoint is
 * one the host's egress reaches. Both hosts list through this one rule.
 *
 * @since 1.0.0
 * @category conversions
 */
export const servableModels = (
  rows: ReadonlyArray<ConfiguredModel>,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelPlanOptions = {}
): ReadonlyArray<ConfiguredModel> => rows.filter((row) => planModelBinding(bindingOf(row), credentials, options).ok)

/**
 * Validates `GET /api/model/catalog`: the built-in models this host serves,
 * the credential names it resolves, and the seats it reads. Never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCatalogSchema = z.strictObject({
  models: z.array(ConfiguredModelSchema).max(64),
  credentials: z.array(ModelCredentialListingSchema).max(64),
  seats: z.array(SeatIdSchema).max(MODEL_SEAT_IDS.length)
})
/**
 * The decoded value accepted by {@link ModelCatalogSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>

/**
 * Validates the last test of one model as it is stored and shown.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestRecordSchema = z.strictObject({
  id: ModelRecordIdSchema,
  testedAt: z.number().finite(),
  result: ModelTestResultSchema
})
/**
 * The decoded value accepted by {@link ModelTestRecordSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestRecord = z.infer<typeof ModelTestRecordSchema>

/**
 * The states a model row's test mark reads as (`data-test-state`).
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_STATES = ["idle", "running", "passed", "failed"] as const
/**
 * One state of a model row's test mark.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestState = (typeof MODEL_TEST_STATES)[number]
/**
 * The state of one model row: running while its test is out, otherwise what
 * its last result says, and idle when it has none.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelTestStateOf = (test: ModelTestRecord | undefined, running: boolean): ModelTestState =>
  running ? "running" : test === undefined ? "idle" : test.result.ok ? "passed" : "failed"

/**
 * The one fix a failed test offers, chosen by the fault its result carries:
 * the record's own mistake (`user`) is edited, and any other fault is not the
 * record's, so the test is tried again. A host row cannot be edited.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelTestFixOf = (builtin: boolean, result: ModelTestResult | undefined): "test" | "edit" =>
  builtin || (result?.ok === false && result.fault !== "user") ? "test" : "edit"

/**
 * Validates the `models` card's payload (Cards.ts).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelsCardPayloadSchema = z.object({
  models: z.array(ConfiguredModelSchema),
  /** Only the seats the host listed; a null `recordId` means the host's default answers. */
  seats: z.array(z.strictObject({
    id: SeatIdSchema,
    recordId: ModelRecordIdSchema.nullable(),
    /** False when the assigned record is gone or its credential is not present. */
    resolvable: z.boolean()
  })),
  /** Names, presence and origins. No value exists on this wire. */
  credentials: z.array(ModelCredentialListingSchema),
  /** The last result per model, at most one each. */
  tests: z.array(ModelTestRecordSchema),
  /** Tests requested and not yet settled; relaunched after a reload. */
  testing: z.array(ModelRecordIdSchema),
  /** A catalog refresh survives reload; a failed refresh keeps its typed refusal until retried. */
  refresh: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("requested") }),
    z.strictObject({ state: z.literal("failed"), failure: ModelTestFailureSchema })
  ]).optional(),
  host: z.enum(["observed", "unavailable"]),
  selected: ModelRecordIdSchema.optional(),
  /** Why the card surfaced unasked: the one row it shows. */
  attention: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("test-failed"), recordId: ModelRecordIdSchema }),
    z.strictObject({ kind: z.literal("seat-unresolved"), seat: SeatIdSchema })
  ]).optional(),
  /** The catalog refresh's typed refusal, formatted as its code and detail. */
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link ModelsCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelsCardPayload = z.infer<typeof ModelsCardPayloadSchema>
