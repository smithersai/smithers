# Models: the decisions behind the surface

The models surface lets a person create, test and assign a configured model from
chat. This page records the decisions that shaped it and the reasons, so a later
change keeps the properties that matter. The exact exports are in
`packages/rpc/src/ConfiguredModel.ts`; the manual test script is
`apps/app/e2e/real/models/MANUAL.md`.

The decision that is expensive to reverse is R4: a credential is a name pinned to
the origins it may be sent to, and a request body can never introduce an origin.
Every button is also an agent act, so a free endpoint beside a server-held key is
key exfiltration.

## R1. One contract module
`packages/rpc/src/ConfiguredModel.ts` — zod only. The rpc import law
(`packages/rpc/test/NativeAgent.test.ts:185-196`) forbids `effect` and `@smthrs/*` there.
Route path constants go in
`packages/rpc/src/AgentApiRoutes.ts` (RouteOwnership test), not in the contract module.

## R2. Two routes, under the family the README already owns
- `GET  /api/model/catalog` -> `{ models, credentials, seats }` (builtin models this host can serve, credential NAMES with `present`
  and their allowed origins, and the seat ids this host resolves). Never a value.
- `POST /api/model/test`    -> `{ model: ConfiguredModel }` -> HTTP 200 with a typed
  result for BOTH outcomes; only transport refusals use the existing envelopes.
NOT `/api/models`, NOT `/api/model/credentials`.

## R3. The record is flat, and the name is the id
`{ id, protocol, baseUrl?, path?, modelId, credential, builtin? }`. `id` is the slug the
user types as the name; no separate label; renaming saves a copy. Kind is derived:
`modelKindOf(protocol)`. Protocols: `anthropic-messages`, `openai-responses`,
`openai-chat`, `evaluation`. Flat because the FORM LAW cannot render unions or
conditional fields.

## R4. A credential is a NAME pinned to ORIGINS — this is the security model
Exfiltration, not loopback, is the hole: agent parity means a prompt-injected agent can
file `{credential: "CEREBRAS_API_KEY", baseUrl: "https://attacker"}`. Therefore:
- `MODEL_CREDENTIALS` in the contract maps each built-in name to its allowed https
  origins: ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY,
  AI_GATEWAY_API_KEY. Built-in names read their standard env name.
- A CUSTOM credential exists only on the local Bun host and only when the OPERATOR
  declares the env pair `SMITHERS_MODEL_KEY_<NAME>=<value>` and
  `SMITHERS_MODEL_KEY_<NAME>_ORIGIN=<origin>`. The mandatory prefix means the route can
  never be made to read an arbitrary env var; the declared origin is the only place that
  value may be sent. Only an operator-declared origin may be loopback/private/`http:`,
  and `http:` only for loopback hosts. A `_ORIGIN` sibling of a built-in name is ignored.
- `resolveModelEndpoint(model, credentials)` refuses any baseUrl whose origin is not in
  the named credential's list: failure code `endpoint_forbidden`. The request body can
  never introduce an origin.
- The Worker resolves exactly CEREBRAS_API_KEY and AI_GATEWAY_API_KEY from ServerConfig
  and never scans env.
- The value is `Redacted` from the moment it is read; it must be unable to reach a log,
  an error message, a response body, the DOM, or a test artifact. Redirects are never
  followed (`redirect: "manual"`; a 3xx is `refused`).
This gives the operator a self-hosted endpoint (declare the pair, then create the model
in the UI) without ever typing a key into the app.

## R5. Seats: only seats something reads
`MODEL_SEATS`, closed, three rows: `explainer` (generation; local + cloud),
`front-door` (decision; cloud), `recommend` (decision; cloud). A seat nothing reads is a
failed feature and MINIMAL TEXT forbids a row whose value is "not wired". The six agent roles are not seats: nothing reads them since the local backend was retired. `DECISION_MODEL_IDS = ["typesafe-ai/jev"]`.

## R6. Consumers wired
- `explainer`: the live `agent.explain` sealed side turn carries `model: ModelBinding`.
  Local Bun host serves it through a real `@smthrs/model` Route; the Worker through the
  existing `cerebrasChat`. A turn carrying `model` plus tools is refused
  `tools_not_supported`; it never falls back to the upstream.
  Local bootstrap advertises `model.turn` independently of `agent`: an offline
  host can explain through an operator-declared loopback binding, while an
  unbound turn remains unavailable. The local answer is buffered up to 65,536
  characters and published once after `cutModelCredential` sanitizes the whole
  text. Partial answers on failure use the same rule; output beyond the bound
  fails `invalid · protocol`. Worker answers use that same sanitizer before
  checking for empty text or building frames. Test samples use it too.
- `front-door` and `recommend`: the client sends the assigned decision model id; the
  Worker validates against `DECISION_MODEL_IDS`; an id off the list is `request_invalid`
  400, never a silent default; absent = today's default.
- `/api/jev`, `/api/model/stream`, `keys.byok`: untouched. `keys.byok` stays the pinned
  ORPHAN in `parity-hosts.test.ts:524`; e2e scenarios do NOT use it as a capability.

## R7. Test is instant-ack background work
`model.test` returns `{ value: "Requested" }` before the fetch, runs under the shared
toast stack, dedupes, reconnects after reload, drops stale responses. One deadline
`MODEL_TEST_DEADLINE_MS = 15000` echoed in the timeout failure as `deadlineMs` — the UI
reads the number from the record, never a constant. NO retries: add the small
provider-general `maxRetries` option to `@smthrs/model` `RequestExecutor` (the default
ladder would turn one Test into many requests). The failure union carries codes,
numbers, enums and the echoed credential NAME — no server free text.
Recovery starts after identity loads or is adopted, using that account epoch.
`model.list` also returns `{ value: "Requested" }`: the card persists
`refresh: { state: "requested" }` before the catalog fetch, and duplicate human
and agent requests share the background work and the `model.list` toast. The
shared 300 ms debounce covers the whole refresh. Success clears the request;
failure persists `{ state: "failed", failure: ModelTestFailure }` and offers
Retry on the failed toast. Reload reconnects pending refreshes after identity;
an earlier account's response cannot overwrite the new account's catalog.

## R8. Sign-in
On the LOCAL host `model.test` needs no sign-in: it spends the operator's own env key on
their own machine. On the Worker both routes sit behind `requireTurnSession` and Test
spends one `loginBudget` turn. So the flow's `requires` must NOT be `signed-in`
globally; the Worker's typed refusal is shown on the card.

## R9. App state
Collections `app-models`, `app-seats`; nothing is seeded — builtin rows arrive through a
`models.observed` system transition built from the host's catalog answer. The controller
(`state/controller/models.ts`), NOT a `*Seam.ts`, makes the two calls
(`parity-hosts.test.ts:240` lists `model` in API_HEADS). Flows: `model.list`,
`model.new`, `model.edit`, `model.save`, `model.show`, `model.remove`, `model.test`,
`model.assign` — a FRESH namespace; never reuse a retired `agent.*` name.
APP_PROJECTOR_VERSION 10 -> 11; APP_SCHEMA_VERSION stays 14. Presentation reaches the
card body through `CardActions.presentation`. Follow the app's existing CSS/card idiom;
do not introduce `@smthrs/ui` form components apps/app has never imported.
