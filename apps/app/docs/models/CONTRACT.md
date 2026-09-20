# Models surface: CONTRACT

Amended for in-app enrollment on 2026-09-19. Section 8 supersedes the earlier
environment-only and two-route restrictions. This workspace copy is the updated
contract; the externally supplied original remains untouched.

Authoritative. Code against THIS file and `RULINGS.md`; where a seam design (`0-` to `3-`) spells
something differently, this file wins. Every name below EXISTS in the workspace
(`/Users/williamcory/smithers-models`) and is green under `packages/rpc` check, lint and test.
Use names VERBATIM. Never redefine one. If you need a shared name that is not here, report a blocker.

Names from the seam designs that DO NOT EXIST: `@smthrs/rpc/ModelConfig`, `@smthrs/rpc/Models`,
`MODELS_PATH`, `MODELS_TEST_PATH`, `MODEL_CREDENTIALS_PATH`, `/api/models`, `/api/model/credentials`,
`MODEL_PROVIDERS`, `planModel`, `bindingFailureCode`, `modelTestFault`, `MODEL_TEST_FAULTS`,
`CredentialNameSchema`, `CredentialListingSchema`, `HostSeatSchema`, `ModelsObservationSchema`,
`ModelCredentialsResponseSchema`, `seatKind`, `role:*` / `decision:*` seat ids, protocol spellings
`anthropic` / `decision` / `vercel-evaluation`, failure codes `authentication` / `rate_limited` /
`call_timeout` / `transport` / `invalid_provider_output` / `no_answer`, form field `timeoutMs`,
fault `provider`.

## 1. Imports

```ts
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { /* everything in section 3 */ } from "@smthrs/rpc/ConfiguredModel"
import { FORM_OPTION_PROVIDERS } from "@smthrs/rpc/Cards"
```

`ConfiguredModel.ts` is zod only. It reads no environment, performs no I/O and holds no value.
mainview may import it. `@smthrs/model` is imported only from `apps/app/src/bun/*`.

## 2. Routes (`packages/rpc/src/AgentApiRoutes.ts`)

```ts
export const MODEL_CATALOG_PATH = "/api/model/catalog"
export const MODEL_TEST_PATH = "/api/model/test"
```

Both hosts answer both routes themselves. Neither is proxied: no `PLATFORM_PROXY_RULES` row, no
`PRODUCT_PROXY_PREFIXES` entry.

### GET /api/model/catalog
- Request: no body.
- 200 body: `ModelCatalog` = `{ models: ConfiguredModel[], credentials: ModelCredentialListing[], seats: SeatId[] }` (strict).
  - `models`: built-in rows this host can serve, each with `builtin: true`. List a row only when a Test of it on this host would plan ok (credential `present` AND endpoint reachable under this host's egress): `servableModels(rows, table, options)` with the SAME options the host's Test plans with. An offline Bun host therefore lists no non-loopback row.
  - `credentials`: Bun host = environment credentials plus the keychain listing (section 8). Worker = exactly two rows, `CEREBRAS_API_KEY` and `AI_GATEWAY_API_KEY`, `present` from `ServerConfig`, `origins` copied from `MODEL_CREDENTIALS`. The Worker never scans env.
  - `seats`: `modelSeatsOf("local")` = `["explainer"]`; `modelSeatsOf("cloud")` = `["explainer", "front-door", "recommend"]`.
- Never a value anywhere in the body.
- Non-200: the host's existing refusal envelope. Worker: behind `requireTurnSession`. Local: behind the existing local session header and Origin gate; no sign-in.

### POST /api/model/test
- Request body: `ModelTestRequest` = `{ model: ConfiguredModel }` (strict, max `MODEL_TEST_BODY_MAX_BYTES`). The client MUST strip app-only fields (`lastTest`) before sending; an extra key is `request_invalid`.
- 200 body for BOTH outcomes: `ModelTestResult`
  - pass: `{ ok: true, latencyMs: number, sample: string }` (`sample` = `scrubModelSample(text, secretValue)`, may be `""`; an empty sample is still a pass)
  - fail: `{ ok: false, latencyMs: number, failure: ModelTestFailure, fault: PlueFault }`; build it ONLY with `failedModelTest(failure, latencyMs, host)`.
- Non-200 only for a refusal to run the test: `request_invalid`, body-size codes, `sign_in_required`, `account_not_allowlisted`, the turn limit. Worker: `requireTurnSession` then one `loginBudget` turn. Local: no sign-in (R8).
- Host procedure, identical on both hosts:
  1. `const table = <this host's ModelCredentialListing[]>`
  2. `const planned = planModelBinding(bindingOf(model), table, { egress })`; `!planned.ok` -> `failedModelTest(planned.failure, ...)`, NO network call.
  3. Read the secret by name from the refreshed keychain/environment snapshot (Bun) or the closed two-entry map (Worker). Wrap in `Redacted` at the read.
  4. One request to `planned.plan.url`, `redirect: "manual"`, no retries, deadline `MODEL_TEST_DEADLINE_MS`.
  5. Map the outcome (the ONLY mapping; no message is ever read):

| Outcome | Failure |
| --- | --- |
| HTTP 300 to 599 (a 3xx is never followed) | `{ code: "refused", status }` |
| no response, connection error | `{ code: "unreachable" }` |
| deadline ran out | `{ code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS }` |
| 2xx that does not decode as the protocol; a protocol this host cannot speak (Worker: `anthropic-messages`, `openai-responses`) | `{ code: "invalid", field: "protocol" }` |

  - Generation prompt: `MODEL_TEST_PROMPT`, max tokens `MODEL_TEST_MAX_TOKENS`. Decision question: `MODEL_TEST_DECISION`; sample = `` `${probability >= 0.5} ${probability.toFixed(2)}` ``.
  - `egress: false` when the Bun host runs `cloudMode: "offline"`; otherwise omit.

## 3. `packages/rpc/src/ConfiguredModel.ts` exports (exact)

### Protocols and kinds
```ts
export const MODEL_PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-chat", "evaluation"] as const
export const ModelProtocolSchema: z.ZodEnum            // z.enum(MODEL_PROTOCOLS)
export type ModelProtocol = "anthropic-messages" | "openai-responses" | "openai-chat" | "evaluation"
export const MODEL_KINDS = ["generation", "decision"] as const
export type ModelKind = "generation" | "decision"
export const modelKindOf: (protocol: ModelProtocol) => ModelKind      // "evaluation" -> "decision"
export type ModelHost = "local" | "cloud"
export const MODEL_PROTOCOL_DEFAULTS: Readonly<Record<ModelProtocol, { readonly baseUrl: string | undefined; readonly path: string }>>
//  anthropic-messages  https://api.anthropic.com     /v1/messages
//  openai-responses    https://api.openai.com        /v1/responses
//  openai-chat         undefined (baseUrl required)  /v1/chat/completions   (the only protocol that honours record.path)
//  evaluation          https://ai-gateway.vercel.sh  /v4/ai/evaluation-model
```

### The record (R3: flat; the name is the id)
```ts
export const MODEL_SEAT_DEFAULT = "default"                       // reserved word; never a model name
export const MODEL_RECORD_ID = /^(?!default$)[a-z][a-z0-9-]{0,39}$/
export const ModelRecordIdSchema: z.ZodString
export type ModelRecordId = string

export const ConfiguredModelSchema   // z.strictObject
export type ConfiguredModel = {
  id: string                  // ModelRecordIdSchema
  protocol: ModelProtocol
  baseUrl?: string            // 1..512, no whitespace; absent = protocol default
  path?: string               // 1..256, no whitespace; openai-chat only
  modelId: string             // AgentRoles ModelIdSchema: /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/
  credential: string          // ModelCredentialNameSchema
  builtin?: boolean           // true only on rows a host catalog reported; user rows OMIT it
}

export const ModelBindingSchema      // z.strictObject: the record without id and builtin
export type ModelBinding = { protocol: ModelProtocol; baseUrl?: string; path?: string; modelId: string; credential: string }
export const bindingOf: (model: ConfiguredModel) => ModelBinding
```
Strict everywhere: an `apiKey` or any other extra key is refused. App persistence extends, never redefines:
`ConfiguredModelSchema.extend({ lastTest: ModelTestRecordSchema.optional() })`.

### Credentials (R4)
```ts
export const MODEL_CREDENTIAL_NAME = /^(?!(?:.*_)?ORIGIN$)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
export const ModelCredentialNameSchema: z.ZodString    // length 2..63; a name ending in ORIGIN is refused
export type ModelCredentialName = string
export const MODEL_CREDENTIALS = [
  { name: "ANTHROPIC_API_KEY", origins: ["https://api.anthropic.com"] },
  { name: "OPENAI_API_KEY", origins: ["https://api.openai.com"] },
  { name: "CEREBRAS_API_KEY", origins: ["https://api.cerebras.ai"] },
  { name: "OPENROUTER_API_KEY", origins: ["https://openrouter.ai"] },
  { name: "AI_GATEWAY_API_KEY", origins: ["https://ai-gateway.vercel.sh"] }
] as const
export type BuiltinModelCredentialName = (typeof MODEL_CREDENTIALS)[number]["name"]
export const isBuiltinModelCredential: (name: string) => name is BuiltinModelCredentialName

export const MODEL_CREDENTIAL_ENV_PREFIX = "SMITHERS_MODEL_KEY_"
export const MODEL_CREDENTIAL_ORIGIN_SUFFIX = "_ORIGIN"
export type ModelCredentialEnv = Readonly<Record<string, string | undefined>>
export const modelCredentialEnvName: (name: string) => string
//  built-in -> the name itself ("OPENAI_API_KEY"); anything else -> "SMITHERS_MODEL_KEY_" + name. THE only env name a value is read from.
export const modelOriginOf: (value: string | undefined) => string | undefined
//  canonical origin; https any host; http loopback only (localhost, 127.0.0.0/8, [::1]); userinfo/query/hash -> undefined
export const isLoopbackOrigin: (origin: string) => boolean
export const customModelCredentials: (env: ModelCredentialEnv) => ReadonlyArray<{ readonly name: string; readonly origin: string }>
//  PURE. One entry per SMITHERS_MODEL_KEY_<NAME>_ORIGIN whose value passes modelOriginOf. Unprefixed keys are never read.
//  A pair spelled with a built-in name declares nothing. Sorted by env key. Never returns a value.

export const ModelCredentialListingSchema   // z.strictObject
export type ModelCredentialListing = { name: string; present: boolean; origins: string[] }   // origins max 8
export const hostModelCredentials: (env: ModelCredentialEnv) => ReadonlyArray<ModelCredentialListing>
//  Bun host only: the five built-ins, then the custom pairs; `present` = the env value is non-blank. Only presence leaves it.
```
Custom credential, operator side: `SMITHERS_MODEL_KEY_OLLAMA=<value>` plus
`SMITHERS_MODEL_KEY_OLLAMA_ORIGIN=http://127.0.0.1:11434`; the record then says `credential: "OLLAMA"`.
e2e: the runner must export BOTH `SMITHERS_MODEL_KEY_E2E_LOOPBACK` and
`SMITHERS_MODEL_KEY_E2E_LOOPBACK_ORIGIN=http://127.0.0.1:<provider port>` (and the same pair for
`E2E_REVOKED`) BEFORE the local host starts, so the provider port is chosen before the host boots.
A name with no `_ORIGIN` declaration (for example `HOME`, `PATH`, `GITHUB_TOKEN`) is
`credential_unknown`, not `credential_missing`. `keys.byok` is not used (R6).

### Endpoint pinning and the planner
```ts
export interface ResolvedModelEndpoint { readonly origin: string; readonly baseUrl: string; readonly path: string; readonly url: string }
export interface ModelEndpointOptions { readonly egress?: boolean }      // false = loopback only
export const resolveModelEndpoint: (
  model: Pick<ConfiguredModel, "protocol" | "baseUrl" | "path" | "credential">,
  credentials: ReadonlyArray<ModelCredentialListing>,                    // the HOST's table, never the request's
  options?: ModelEndpointOptions
) => { readonly ok: true; readonly endpoint: ResolvedModelEndpoint } | { readonly ok: false; readonly failure: ModelTestFailure }

export interface ModelPlan extends ResolvedModelEndpoint {
  readonly kind: ModelKind; readonly protocol: ModelProtocol; readonly modelId: string; readonly credential: string
}
export interface ModelPlanOptions extends ModelEndpointOptions { readonly kind?: ModelKind }
export type PlannedModel = { readonly ok: true; readonly plan: ModelPlan } | { readonly ok: false; readonly failure: ModelTestFailure }
export const planModelBinding: (input: unknown, credentials: ReadonlyArray<ModelCredentialListing>, options?: ModelPlanOptions) => PlannedModel
```
```ts
export const servableModels: (rows: ReadonlyArray<ConfiguredModel>, credentials: ReadonlyArray<ModelCredentialListing>, options?: ModelPlanOptions) => ReadonlyArray<ConfiguredModel>
//  PURE. The one catalog row rule, called by BOTH hosts: a row is kept only when planModelBinding(bindingOf(row), credentials, options).ok
```
`planModelBinding` order, first failure wins:
1. not a `ModelBinding` -> `{ code: "invalid", field }` (the offending field, else `"model"`)
2. `options.kind` given and differs from `modelKindOf(protocol)` -> `{ code: "invalid", field: "protocol" }`
3. name not in the table -> `{ code: "credential_unknown", credential }`
4. no base URL (openai-chat), unparseable, userinfo/query/hash -> `{ code: "invalid", field: "baseUrl" }`
5. origin not pinned to the credential, or `egress:false` and not loopback -> `{ code: "endpoint_forbidden" }`
6. a `path` on a non-openai-chat record that is not the default, or an unsafe path -> `{ code: "invalid", field: "path" }`
7. decision kind on a BUILT-IN credential with `modelId` off `DECISION_MODEL_IDS` -> `{ code: "model_not_allowed" }`
8. credential listed with `present: false` -> `{ code: "credential_missing", credential }`
Pinning is judged before presence. A plan never holds a value.

### Seats (R5) and the decision allowlist
```ts
export const DECISION_MODEL_IDS = ["typesafe-ai/jev"] as const
export const DecisionModelIdSchema: z.ZodEnum
export type DecisionModelId = "typesafe-ai/jev"
export const MODEL_SEAT_IDS = ["explainer", "front-door", "recommend"] as const
export const SeatIdSchema: z.ZodEnum
export type SeatId = "explainer" | "front-door" | "recommend"
export interface ModelSeat { readonly id: SeatId; readonly label: string; readonly kind: ModelKind; readonly hosts: ReadonlyArray<ModelHost> }
export const MODEL_SEATS = [
  { id: "explainer", label: "Explainer", kind: "generation", hosts: ["local", "cloud"] },
  { id: "front-door", label: "Front door", kind: "decision", hosts: ["cloud"] },
  { id: "recommend", label: "Recommendations", kind: "decision", hosts: ["cloud"] }
] as const
export const modelSeat: (id: SeatId) => ModelSeat
export const modelSeatsOf: (host: ModelHost) => ReadonlyArray<SeatId>
export const seatAccepts: (seat: SeatId, protocol: ModelProtocol) => boolean
export const SeatAssignmentSchema   // z.strictObject({ id: SeatIdSchema, recordId: ModelRecordIdSchema })
export type SeatAssignment = { id: SeatId; recordId: string }     // row key = seat; an unassigned seat has NO row
```
Seat labels on screen come from `modelSeat(id).label`.

### Test: request, result, typed failure, fault
```ts
export const MODEL_TEST_DEADLINE_MS = 15_000
export const MODEL_TEST_BODY_MAX_BYTES = 8 * 1024
export const MODEL_TEST_MAX_TOKENS = 32
export const MODEL_TEST_SAMPLE_MAX = 80
export const MODEL_TEST_PROMPT = "Reply with the single word: ok"
export const MODEL_TEST_DECISION = { state: { text: "The sky is blue." }, questions: { ok: { type: "boolean", instructions: "Does the text mention a color?" } } } as const

export const ModelTestRequestSchema   // z.strictObject({ model: ConfiguredModelSchema })
export type ModelTestRequest = { model: ConfiguredModel }

export const MODEL_INVALID_FIELDS = ["model", "protocol", "baseUrl", "path", "modelId", "credential"] as const
export type ModelInvalidField = (typeof MODEL_INVALID_FIELDS)[number]
export const MODEL_TEST_FAILURE_CODES = ["unreachable", "refused", "timeout", "invalid", "credential_missing", "credential_unknown", "endpoint_forbidden", "model_not_allowed", "host_refused"] as const
export const ModelTestFailureSchema   // z.discriminatedUnion("code", strict branches)
export type ModelTestFailure =
  | { code: "unreachable" }
  | { code: "refused"; status: number }                 // int 300..599
  | { code: "timeout"; deadlineMs: number }             // the deadline that armed it; the UI reads THIS number
  | { code: "invalid"; field: ModelInvalidField }
  | { code: "credential_missing"; credential: string }  // NAME only
  | { code: "credential_unknown"; credential: string }  // NAME only
  | { code: "endpoint_forbidden" }
  | { code: "model_not_allowed" }
  | { code: "host_refused"; refusal: string | null; status: number | null; fault: PlueFault }   // written by the CLIENT only

export const modelFailureFault: (failure: ModelTestFailure, host: ModelHost) => PlueFault
//  unreachable, timeout -> dependency; refused 429 -> wait, >=500 -> dependency, else user;
//  invalid, credential_unknown, endpoint_forbidden, model_not_allowed -> user;
//  credential_missing -> user (local) | infra (cloud); host_refused -> failure.fault
export const modelFailureRefusalCode: (failure: ModelTestFailure) => WorkerFailureCode
//  for refusing a TURN whose binding failed (never the test route):
//  invalid | credential_unknown | endpoint_forbidden | model_not_allowed -> request_invalid; credential_missing -> seam_not_configured;
//  unreachable -> upstream_unreachable; timeout -> upstream_timeout; refused 429 -> model_rate_limited, else upstream_refused; host_refused -> unexpected_failure

export const ModelTestResultSchema   // z.discriminatedUnion("ok", strict branches)
export type ModelTestResult =
  | { ok: true; latencyMs: number; sample: string }     // sample max 80 chars
  | { ok: false; latencyMs: number; failure: ModelTestFailure; fault: PlueFault }
export const failedModelTest: (failure: ModelTestFailure, latencyMs: number, host: ModelHost) => ModelTestResult
export const hostRefusedModelTest: (
  refusal: { readonly code: string | null; readonly status: number | null; readonly fault: PlueFault },   // a Refusal (Refusal.ts) fits
  latencyMs: number
) => ModelTestResult
export const scrubModelSample: (text: string, secret: string) => string
export const cutModelCredential: (text: string, secret: string) => string
//  the ONE cut: every occurrence of the value removed (rescanned until none), nothing else touched. scrubModelSample = this, then
//  whitespace collapse + MODEL_TEST_SAMPLE_MAX. Bun sealed turns buffer up to 65,536 characters, then sanitize the entire answer
//  before publishing once; partial output on failure uses the same rule. An overflow is invalid/protocol. Worker turns sanitize
//  answer.content before the empty-answer check and frame construction. No streaming credentialCut API exists.

export const ModelTestRecordSchema   // z.strictObject
export type ModelTestRecord = { id: string; testedAt: number; result: ModelTestResult }
export const MODEL_TEST_STATES = ["idle", "running", "passed", "failed"] as const
export type ModelTestState = "idle" | "running" | "passed" | "failed"
export const modelTestStateOf: (test: ModelTestRecord | undefined, running: boolean) => ModelTestState
export const modelTestFixOf: (builtin: boolean, result: ModelTestResult | undefined) => "test" | "edit"
//  the ONE fix a failed test offers, used by the card's attention button AND the failed toast's action:
//  builtin, or a failed result whose fault is not `user` (wait, dependency, infra, bug) -> "test" (model.test, label Test); else "edit" (model.edit, label Edit)
```
`PlueFault` = `"user" | "wait" | "infra" | "dependency" | "bug"` (`@smthrs/rpc/PlueFailureCodes`). There is no `provider` fault.
No failure branch has a free-text field. The client turns a non-200, an undecodable 200 or a thrown fetch into
`hostRefusedModelTest(refusalOf(...), latencyMs)`; the refusal's message is never stored.

Mapping from the e2e design's codes: `authentication` -> `refused` status 401 (fault `user`); `rate_limited` -> `refused`
status 429 (fault `wait`); `call_timeout` -> `timeout`; `transport` -> `unreachable`; `invalid_provider_output` ->
`invalid` field `protocol`; `credential_missing` unchanged.

### Catalog and card payload
```ts
export const ModelCatalogSchema   // z.strictObject; models max 64, credentials max 64
export type ModelCatalog = { models: ConfiguredModel[]; credentials: ModelCredentialListing[]; seats: SeatId[] }
export const ModelsCardPayloadSchema
export type ModelsCardPayload = {
  models: ConfiguredModel[]
  seats: { id: SeatId; recordId: string | null; resolvable: boolean }[]   // only seats the host listed; null = host default
  credentials: ModelCredentialListing[]
  tests: ModelTestRecord[]            // last result per model, at most one each
  testing: string[]                   // ids requested and not settled; relaunched after identity loads on reload
  refresh?: { state: "requested" } | { state: "failed"; failure: ModelTestFailure } // durable catalog refresh
  host: "observed" | "unavailable"
  selected?: string
  attention?: { kind: "test-failed"; recordId: string } | { kind: "seat-unresolved"; seat: SeatId }
  error?: string                      // modelFailureLine of the typed catalog refusal
}
```

## 4. `packages/rpc/src/Cards.ts`

- New card kind: `{ ...cardBaseShape, kind: "models", payload: ModelsCardPayloadSchema }`. `Extract<Card, { kind: "models" }>` works.
- `FORM_OPTION_PROVIDERS` gained, in this order after `"files"`: `"models"`, `"credentials"`, `"seats"`.
  apps/app `flows/FlowForms.ts` `OPTION_PROVIDERS` and the exhaustive `optionsFor` switch in `state/controller/forms.ts` MUST add the same three or apps/app stops compiling.
  - `models`: `app-models` rows; when `draft.seat` is a `SeatId`, only rows where `seatAccepts(seat, row.protocol)`, preceded by `{ value: MODEL_SEAT_DEFAULT, label: "Default" }`.
  - `credentials`: the models card's `payload.credentials`; `present: false` -> `{ disabled: true, reason: "missing" }`.
  - `seats`: the models card's `payload.seats`, label `modelSeat(id).label`.
- `retiredFlows` / `retiredKinds` untouched: a stored `agent-models` card still decodes as `retired`.
- The one card has id `"models"` (`MODELS_CARD_ID`, app-owned constant in `state/controller/models.ts`).

## 5. Flows (R9), exact names and inputs

| Flow | args | input | Notes |
| --- | --- | --- | --- |
| `model.list` | none | none | persists a catalog refresh, returns `{ value: "Requested" }`, then reads in deduplicated background work |
| `model.new` | none | none | opens the `model.save` form |
| `model.edit` | `<name>` | `{ id: string }` | opens `model.save` prefilled; a builtin row is refused |
| `model.save` | `--name --protocol --model --credential [--url] [--path]` | `{ name, protocol, modelId, credential, baseUrl?, path? }` | flags map `model`->`modelId`, `url`->`baseUrl`, `path`->`path`; `name` becomes `id` |
| `model.show` | `<name>` | `{ id: string }` | writes `payload.selected` |
| `model.remove` | `<name>` | `{ id: string }` | confirm |
| `model.test` | `<name>` | `{ id: string }` | returns `{ value: "Requested" }` before the fetch; NOT `requires: ["signed-in"]` (R8) |
| `model.assign` | `<seat> <name\|default>` | `{ seat: string, recordId: string }` | `recordId === MODEL_SEAT_DEFAULT` deletes the seat's row |

Form fields (testids `flow-form-<field>`, submit `flow-form-submit`): `name`, `protocol` (select over `MODEL_PROTOCOLS`),
`baseUrl`, `path`, `modelId`, `credential` (select from `credentials`; a text input only when the host listed none),
and for assign `seat`, `recordId`. There is no `timeoutMs` field: the one deadline is `MODEL_TEST_DEADLINE_MS`.

Transitions (app-owned, stated so reducer and controller agree):
```ts
| { type: "models.observed"; actor: "system"; models: ReadonlyArray<ConfiguredModel> }
| { type: "model.saved"; actor: Actor; model: ConfiguredModel }
| { type: "model.removed"; actor: Actor; id: ModelRecordId }
| { type: "model.tested"; actor: "system"; test: ModelTestRecord }
| { type: "seat.assigned"; actor: Actor; seat: SeatId; recordId: ModelRecordId | null }
```
Collections `app-models` (rows `ConfiguredModel & { lastTest?: ModelTestRecord }`) and `app-seats` (rows `SeatAssignment`).
Catalog toast key: `model.list`. Shared 300 ms debounce; it settles only with the catalog response. A failed refresh persists a typed `host_refused` failure and the toast offers `model.list` (Retry). Requested refreshes and tests resume after identity loading/adoption, using the current account epoch. Duplicate human and agent refreshes share one flight; stale account responses write nothing.

Toast key for a test: `` `model.test:${id}` ``. A test in flight is keyed by model id AND account epoch: a press after an account change starts its own test and its result is kept; the departed account's answer writes nothing.

## 6. What a request carries (R6)

Local bootstrap advertises `model.turn` independently of the default `agent`. The runtime constructs the HTTP transport when either is present, but ordinary agent availability still requires `agent`. `agent.explain` accepts a valid configured binding on `model.turn`, including an operator-declared loopback provider while offline. An unbound offline turn remains unavailable.

- `StartAgentTurnRequest.model?: ModelBinding`: the sealed `agent.explain` side turn, seat `explainer`. Host: `planModelBinding(body.model, table, { kind: "generation" })`; failure -> `refuse(modelFailureRefusalCode(failure), ...)`. `model` plus tools -> `tools_not_supported`. Never a fallback to the upstream. Local turns publish one sanitized text delta at completion (including partial text on failure); Worker turns sanitize their whole answer. Removing echoes cannot reconstruct the exact credential in published text (R4).
- `StartAgentTurnRequest.decisionModel?: ModelBinding`: seat `front-door`. `/api/recommend` body `model?: ModelBinding`: seat `recommend`. Worker: `planModelBinding(binding, workerTable, { kind: "decision" })`; any failure is 400 `request_invalid` via `modelFailureRefusalCode` (an id off `DECISION_MODEL_IDS` is `model_not_allowed` -> `request_invalid`). Absent = today's default. The Jev call uses `plan.modelId`.
- The client builds each with `bindingOf(model)` and sends it only when the seat has a row, the record exists and `seatAccepts(seat, record.protocol)`.

## 7. DOM contract (ONE spelling each)

Card: `.smithers-card[data-kind="models"]`, `data-maximized` like every card. Body root: `data-presentation="embedded" | "maximized"`.

Model row, the ONLY element carrying `data-model-id` (the maximized detail pane must not, or row locators match twice):

| Attribute on the row | Value |
| --- | --- |
| `data-model-id` | the record id |
| `data-testid` | `` `model-row-${id}` `` |
| `data-test-state` | `modelTestStateOf(test, running)`: `idle` \| `running` \| `passed` \| `failed` |
| `data-failure-code` | `failure.code`, present only while `failed` |
| `data-failure-fault` | `result.fault` (`user` \| `wait` \| `infra` \| `dependency` \| `bug`), present only while `failed` |
| `data-builtin` | `"true"` on a host row |
| `data-selected` | `"true"` on the selected row |

Inside the row, in both presentations: buttons with exact accessible names `Test`, `Edit`, `Remove`, each through
`flowAction` so it carries `data-flow` = `model.test` | `model.edit` | `model.remove`. A builtin row has `Test` only.
Failure text in the row is the code plus its number: `refused · 401`, `timeout · 15000 ms` (from `failure.deadlineMs`),
`invalid · baseUrl`, `credential_missing · NAME`. A pass reads `` `${latencyMs} ms` ``. No sentence.

| testid | Element |
| --- | --- |
| `models-list` | the `<ul>` of rows |
| `models-empty` | `No models.` |
| `models-more` | embedded overflow count `+N` |
| `model-new` | the `New` button (`data-flow="model.new"`) |
| `model-detail` | maximized facts pane (no `data-model-id`) |
| `model-credential` | the credential cell in the detail; `data-present="true" \| "false"` |
| `model-seats` | the seats table |
| `models-attention` | unasked row wrapper; `data-kind="test-failed" \| "seat-unresolved"` |
| `models-attention-fix` | its one button: `Assign` for a seat; for a failed test `modelTestFixOf(builtin, result)` picks `Test` or `Edit` |
| `models-error` | `payload.error`, `role="alert"` |

Seat: `<select data-seat="<seat id>" data-flow="model.assign">` inside `<tr data-seat-row="<seat id>" data-resolvable="true|false">`.
Option values are model ids; the first option has value `default` (`MODEL_SEAT_DEFAULT`). Changing it runs
`model.assign` with `{ seat, recordId: value }`. e2e selects `"default"`, never `""`.


## 8. Enrollment amendment (2026-09-19)

Supersedes the environment-only parts of R2/R4 and sections 2, 3 and 5 above.
All existing record, planner, failure, seat, and DOM spellings remain.

`AgentApiRoutes.ts` exports `MODEL_CREDENTIAL_PATH = "/api/model/credential"`
and `MODEL_CREDENTIAL_RECEIPT_PATH = "/api/model/credential/receipt"`.
The former is POST; the latter is GET with an `id` query parameter. Bun's session
header and Origin checks apply. The Worker requires `requireTurnSession` and
answers local_host_required for POST, unknown for receipt, without reading or
forwarding a value. These routes are host-owned, never platform proxies.

`ConfiguredModel.ts` adds these contracts:

```ts
ModelEnrollmentSchema // {available:true}|{available:false,reason:"local_host_required"|"keychain_unavailable"}
ModelCredentialRequestIdSchema // 8..64 ASCII letters/digits/dashes
ModelCredentialRequestSchema
// strict action union: enroll {requestId,name,origin,value}; rotate {requestId,name,value}; remove {requestId,name}
type ModelCredentialRequest
ModelCredentialFailureSchema
// {code:"invalid",field:"name"|"origin"|"value"|"requestId"|"action"}
// | {code:"exists"|"unknown"|"read_only"|"storage_unavailable"|"local_host_required"|"interrupted"}
// | {code:"host_refused",status:number|null,refusal:string|null}
type ModelCredentialFailure
ModelCredentialResultSchema
// {ok:true,credential:ModelCredentialListing}|{ok:false,failure:ModelCredentialFailure,fault:PlueFault}
type ModelCredentialResult
failedModelCredential(failure, fault?) // storage_unavailable defaults to infra; other failures to user
ModelCredentialReceiptSchema // {state:"unknown"}|{state:"completed",result:ModelCredentialResult}
ModelCredentialPendingSchema
// {requestId,name,action,origin?,state:"requested"|"completed"|"failed",failure?,fault?}
```

`ModelCredentialListing` gains optional `managed:boolean`: true for a keychain
credential or its removed pin. `ModelCatalog` and `ModelsCardPayload` gain optional
`enrollment:ModelEnrollmentSchema`. `ModelsCardPayload` also gains optional
`credentialRequests:ModelCredentialPendingSchema[]`, bounded to 64. No value
exists in any of these records. Keychain mutations return only metadata.

| Flow | Public grammar/input | Write-only control | Agent |
| --- | --- | --- | --- |
| `model.credential.new` | none | opens Enroll | may open form |
| `model.credential.enroll` | `[--name <NAME>] [--origin <origin>]` / `{name,origin}` | `value`, API key | confirm |
| `model.credential.rotate` | `<name>` / `{name}` | `value`, API key | confirm |
| `model.credential.remove` | `<name>` / `{name}` | none | confirm |

Enroll and Rotate schema properties include optional `value:Schema.String`,
with form hint `{kind:"write-only",required:true,label:"API key"}`. The optional
property is a declaration for the form, not permission to persist it. The
registry strips it before admission and builds display arguments from public
fields only. `publicFormPayload`, `draftFrom`, `submissionPayload` and
`assembleArgs` exclude write-only fields. `form.set` refuses them. CardSchema
refuses a draft/given containing a declared write-only field. `disabledReason`
can render a disabled option in place of an unavailable control.

The password input holds the edit transiently, clears synchronously on submit,
and gives `writeOnlyGesture` an opaque accessor. `hasWriteOnly` checks presence,
`takeWriteOnly` consumes once, `release` discards unused input. The gesture crosses
`form.submit` and the nested flow without joining serialized input. Agent forms
omit the password until confirmation; the human's confirmation opens that field.
The background controller sends the value once. It never copies request bodies
into the network ring, flow trace, toast or card.

Bun stores one versioned vault per state directory in macOS keychain. Strict
keychain writes verify the stored document before publishing a new snapshot.
Host mutations serialize under an empty SQLite writer-lock file in the state
directory and reread the keychain while holding it. That file never holds rows,
pins or values. A competing writer fails typed; process exit releases the lock.
Existing environment names are read-only; missing
built-ins can enroll only on their contract pin. Repeat enrollment returns
exists. Rotation has no origin field. Removal deletes the value and keeps the
pin, so subsequent enrollment cannot introduce another origin. All consumers
refresh the host snapshot before planning and read the value behind that plan.

Mutation metadata is persisted before background I/O. Requested returns before
the host finishes. A 300 ms debounced toast spans storage and catalog refresh.
Duplicate pending names share one operation. Reload reads a receipt; unknown
becomes interrupted and Retry requires re-entry. Only the current account epoch
may publish completion. The keychain retains the last 128 successful receipts;
older unknown receipts are not guessed or replayed.

New DOM: `model-credentials` is the maximized section; its rows have
`data-credential-name` and `data-present`. `model-credential-new` is Add credential.
Rotate and Remove carry their registered flows. The credential select's
`__enroll` option runs `model.credential.new` and is never saved as a credential.
A failed mutation draws `credential-failure` with its name, code and Retry.

The pre-implementation design and explicit limitations are in ENROLLMENT.md.
The initial external CONTRACT path was read-only under this run's workspace
constraint; this complete copy is its requested update.
