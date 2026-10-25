# Your model (bring your own key)

A person may save one model of their own: a protocol, a base URL, a model id and a key. It is how a person uses
Smithers: from then on the model endpoint answers everything that person causes with it, outside the deployment's daily
budget: their chat, the views and judgments it makes, their timeline summaries, their `todo` runs and their TODOs'
reviews. A person who saved none sees "Add your model" where the composer would be while the deployment's own model is
off, as it is for a deploy ([hosted inference](model-endpoint.md#hosted-inference)). Decisions:
[0096](../decisions/0096-personal-models.md), [0099](../decisions/0099-hosted-inference-flag.md).

```
Settings ▸ Your model (the person, in person)
  protocol · base URL · model · key ── PUT /api/me/model
      check · seal under SECRETS_KEY (person, version) ── model/Put { ciphertext } ── personal_models + audit
  Remove ── model/remove (browser flow; the agent may, after Approve) ── DELETE /api/me/model ── model/Delete
  Test   ── model/test   (browser flow; the agent may)                 ── POST /api/me/model/test ── 200 TestResult

POST /api/model/<role>  (every role; and a todo run's coding seat and its review, for its committer)
  signed in, may ask ─ personal_models[person]?
    yes ─▶ open the key in memory ─▶ the person's provider, key pinned to its origin
           personal_model_usage row · no budget · no spend alert
           401 / 402 / 403 / 429 ─▶ the call fails · failure_status marked · toast   (never the deployment's model)
           the key doesn't open ─▶ 409 no_route
    no  ─▶ hosted inference on ─▶ the deployment's model (model-endpoint.md)
           off ─▶ 409 no_route "Add your model in Settings to ask Smithers."  (the composer shows "Add your model")
```

## Saving

`PUT /api/me/model` with `{ protocol, baseUrl, modelId, key }` saves or replaces the person's model and answers
`202 { baseUrl }` (normalized) once `model/Put` started; the row arrives in the shape.

- **Who:** a signed-in Member or above, in person. An agent, flow, frame or sandbox acting for them is refused
  `forbidden` and counted (`smithers_person_only_refusals`, act `model`): the key would pass through them.
- **Protocol:** `openai-chat` (OpenAI-compatible Chat Completions, `<base URL>/v1/chat/completions`) or
  `anthropic-messages` (Anthropic-compatible Messages, `<base URL>/v1/messages`).
- **Base URL:** `https:` to one public DNS name: no IP address, single label (`localhost`), port, user, query or
  fragment, at most 512 characters. Its host is lowercased and its trailing slashes and one trailing `/v1` dropped:
  `https://api.openai.com/v1` is `https://api.openai.com`, `https://openrouter.ai/api/v1` is `https://openrouter.ai/api`.
- **Model:** the provider's model id: 1 to 81 letters, digits, `.`, `_`, `/`, `:` and `-`, starting with a letter or
  digit.
- **Key:** 16 characters to 16 KiB of text with no control character (`@smthrs/secrets` `Binding.valueProblem`, and at
  least 16 characters so the four the browser sees again are a small part of it). A save always needs the key, so the
  base URL never changes under a saved key.
- **Sealing:** AES-256-GCM under SECRETS_KEY's sealing key, the one repository secrets use, with `person:<id>`, `model`
  and the key's version as the authenticated context: a ciphertext moved to another person's row doesn't open. The
  route seals before the flow starts, so the flow's payload and journal hold only ciphertext. A save clears the last
  refusal.
- **Refusals** answer `{ code }`: `authentication` 401, `forbidden` 403, `invalid` 400 (not the JSON body), and
  `invalid_protocol`, `invalid_base_url`, `invalid_model`, `too_short`, `too_long`, `control_character`,
  `malformed_text` 400, `too_large` 413 (over 32 KiB), `off` 503 (no SECRETS_KEY), `unavailable` 503 (the flow couldn't
  start).

`DELETE /api/me/model` removes it through `model/Delete` and answers `202 {}`: anyone signed in removes their own,
whatever their role, and the agent may for them.

`model/Put` (step `model/Store`) and `model/Delete` (step `model/Erase`) run on the Cloudflare host (`FlowExecution`).
Each writes the row and its `personal_model_events` record in one transaction under its invocation key, so a step run
again records nothing twice. A database failure is `StoreUnavailable`, retried for up to 30 minutes.

## Reading

`GET /api/shapes/personal-model` syncs the person's own row, never another's: `person_id`, `protocol`, `base_url`,
`model_id`, `key_last4`, `failure_status`, `failed_at`, `updated_at`. Never the ciphertext. Signed out, no rows.

## Answering

The model endpoint opens the asker's model before every call (`worker/personal/Models.ts`, `PersonalModels`): their row,
the key opened under SECRETS_KEY, planned by `@smthrs/rpc`'s `ConfiguredModel.planModelBinding` with the key pinned to
the base URL's origin, and built by `@smthrs/model-host`'s `toModel`, whose transport refuses redirects.

- **Everything they cause.** Every role a person's calls name goes to their model: `agent`, `renderer`, `judge` (Jev
  and the memory opening's judge), `summary` (the timeline's summaries, which their tab asks for as they view a
  conversation, a shared branch's included) and `coding` (their `todo` runs); their TODO's review judges with it too.
  The model id is theirs; the request bounds (messages, caps, body size) are the endpoint's. Decision 0099 replaced
  0096's amendment, under which summaries stayed on the deployment's model.
- **Outside the budget.** The call reserves nothing against `MODEL_DAILY_TOKEN_BUDGET`, writes no `model_usage` row and
  starts no spend alert. It writes a `personal_model_usage` row before the model runs, settled when it ends with the
  tokens the model reported, its outcome, its failure's code and the provider's status. A settle Postgres refuses is
  logged and counted (`smithers_personal_model_usage_errors`) and leaves the row unsettled, as the deployment's ledger
  does; a test cancelled while the provider answers settles as `interrupted`.
- **No fallback.** A saved model that can't be used here (its key doesn't open, SECRETS_KEY is unset) is `409 no_route`,
  "Your model can't be used. Save it again in Settings.", logged `own_unusable:<reason>`. Postgres that can't say is
  `503 provider_internal`.
- **A refused key.** A provider's 401, 402 or 403, or a 429 that says the key ran out (`quota_exceeded`,
  `out_of_credit`), fails the call and sets the person's `failure_status` and `failed_at`; a later successful call, a
  passing test or a new save clears them. Only a call made with the row's current key marks it, so a slow call on a key
  the person has since replaced says nothing of the new one. A plain rate limit marks nothing. Quota and credit refusals
  (HTTP 402, `quota_exceeded`, `out_of_credit`) lose their retry hints (`final` in `worker/ModelRefusal.ts`), so the browser's
  model step and a `todo` run fail at once instead of parking; the model package's request executor never retries
  them. A plain rate limit (429 without a quota code) keeps its hints and is waited out as before.

### Todo runs

A `todo` run's agent calls the `coding` seat in process (`ModelEndpoint.local`). The seat reads the run it is called in
(`FlowRuntime.FlowInstance`), and `TodoMachine.ownerOf` its committer from `todos.created_by`; that person's model answers
it exactly as their endpoint calls are answered, so the run works on their key while every device is off.

## Testing

`POST /api/me/model/test` makes one tiny real call with the saved model (`Reply with the single word: ok`, 64 output
tokens, 30 seconds at most), kept in the ledger with role `test`, and answers `200` with a `TestResult`:
`{ ok: true, latencyMs, sample }` (the model's first 80 characters), or `{ ok: false, latencyMs, code, status, host }`:
the `ModelError` code (`unusable` for a saved model that can't be used here), the provider's HTTP status or `null`, and
the provider's host. Nothing saved is `404 none`; a Guest or someone with no role, `403 forbidden`.

## The Settings section

`/app/settings`, the header's Settings link, shows **Your model** to a signed-in Member or above: Protocol, Base URL,
Model and Key (a password field; once saved, its placeholder is the key's last four characters), Save, and Remove and
Test once a model is saved. Someone signed in who may no longer save one, such as a person who lost their role, sees
only Remove while their model is saved. One status line says Saving or Removing, a refusal, the test's result, or the
provider's last refusal with when it happened. While
the person's row has a refusal their device hasn't hidden, the shell's toast stack shows it (`<host> · HTTP <status>`),
opening Settings. The key is read from the form once, held `Redacted`, sent in one `PUT`, and never kept on the device:
not in a collection, the outbox, a browser flow's journal or a record.

## Flows

| Flow | Where | Who | What |
|---|---|---|---|
| `model/Put` | Cloudflare host | the route, for the person in person | writes the sealed model and its audit |
| `model/Delete` | Cloudflare host | the route | deletes the model and records it |
| `model/test` | the device | the person, or the agent | `POST /api/me/model/test` |
| `model/remove` | the device | the person, or the agent after the person approves | `DELETE /api/me/model` |

## Postgres

`db/migrations/0056_personal_models.ts`:

| Table | Columns | |
|---|---|---|
| `personal_models` | `person_id` (key), `protocol`, `base_url`, `model_id`, `ciphertext`, `nonce`, `key_version`, `key_last4`, `failure_status`, `failed_at`, `updated_at` | one person's model; the failure is set and cleared together |
| `personal_model_events` | `id`, `person_id`, `action` (`set`, `replace`, `delete`), `invocation_key` (unique), `at` | the audit of `model/Put` and `model/Delete` |
| `personal_model_usage` | `invocation_id` (key), `request_id`, `person_id`, `role`, `model_id`, `input_tokens`, `output_tokens`, `outcome`, `error_code`, `http_status`, `settled_at`, `created_at` | the person's ledger, apart from the deployment's |

## Observability

Counters `smithers_personal_model_requests` (op, outcome), `smithers_personal_model_shape_requests`,
`smithers_personal_model_writes` (op, change), `smithers_personal_model_calls` (role, outcome),
`smithers_personal_model_tokens` (role, type) and `smithers_personal_model_usage_errors` (op); log lines
`personal_model.request`, `personal_model.write`, `personal_model.call` (a failed or interrupted call: role, outcome,
code, the provider's status) and `personal_model.usage`; spans `personal_model.request` and `personal_model.write`. They
carry ops, outcomes, codes, statuses, roles and counts: never a key, a base URL, a model id or a prompt.

## Tests

- `worker/personal/PersonalModels.test.ts` on the compose Postgres and Electric, with `model/Put` and `model/Delete` on
  the Node host's engine and the person's provider scripted at the network (`worker/personal/test/provider.ts`): saving,
  replacing and removing, every refusal, the person-only refusal of an agent, the shape's rows and columns, the test's
  ok, refused, out-of-quota, timed-out and unusable answers, the endpoint answering every role with the person's model, summaries included, and hosted inference off refusing a person who saved none
  outside the budget and without a spend alert, another person still on the deployment's, a refused key failing at
  once with no fallback and no retry, `409` for a key that doesn't open, `503` for Postgres, a `todo` run's coding seat
  on its committer's model, and a sentinel search for the key in every table, the flow journal and everything
  recorded.
- `worker/PersonOnly.test.ts`: `PUT /api/me/model` refuses an agent, a flow and a frame.
- `db/Database.test.ts`: `0056_personal_models`' tables and their rules.
- `src/features/personal-model/`: the Settings section, the toast and the two browser flows against ChatApi's real
  handler.
- `e2e/personal-model.spec.ts`: a real provider, saved, tested, asked and removed in the browser, locally and in
  production.
