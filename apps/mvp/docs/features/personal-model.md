# Your model (connections)

A person keeps an ordered list of connections, as in Amp's Model Routing: each is one credential plus its settings, and
each is active or not. It is how a person uses Smithers: the model endpoint answers everything that person causes with
their tiers' models, outside the deployment's daily budget. `fast` serves chat, views and summaries, `implement` their
`todo` runs, `hard` plans and reviews. A person who saved none sees "Add your model" where the composer would be while
the deployment's own model is off ([hosted inference](model-endpoint.md#hosted-inference)). Decisions:
[0096](../decisions/0096-personal-models.md), [0099](../decisions/0099-hosted-inference-flag.md),
[0107](../decisions/0107-model-tiers.md), [0132](../decisions/0132-model-connections.md).

| Kind | Credential | Serves |
|---|---|---|
| `api_key` | a key at any OpenAI- or Anthropic-compatible URL | the tiers it names, or presets at the provider's host |
| `moonshot` | a Moonshot key; `MOONSHOT_BASE_URL` and `MOONSHOT_MODEL` fill in the rest (`https://api.moonshot.ai`, `kimi-k3`) | every tier unless it names another model |
| `claude_subscription` | the token `claude setup-token` prints | `todo` runs, through Claude Code in the box |
| `codex_subscription` | OpenAI's device-code tokens | `todo` runs, through Codex in the box |
| `jev` | a Vercel AI Gateway key | the `judge` role ([Jev](jev.md)) |

```
Settings ▸ Your model (the person, in person)
  the list: Active · Move up · Move down · Test · Add
  Add ▸ a kind ▸ its form ── PUT /api/me/model { connections } ── seal each key ── model/Put ── personal_models
  Add ▸ Codex subscription ── POST /api/me/model/codex ── the code ── person types it at OpenAI
                                    model/CodexLink: model/CodexPoll seals ── model/CodexKeep ── personal_models
  Remove ── model/remove ── DELETE /api/me/model ── model/Delete
  Test   ── model/test   ── POST /api/me/model/test ── 200 TestResult

POST /api/model/<role>                     a todo run                       POST /api/me/model/jev
  the role's tier ─▶ first active            todo/Route ─▶ codingChoice       the person's jev connection
  connection naming it ─▶ its key            ├ smithers ─▶ todo/Implement     none ─▶ 404, the fast tier answers
  personal_model_usage · no budget           └ claude-code, codex
  refused ─▶ failure marked on that row         ─▶ todo/ImplementCli
                                                   vendor's agent in the box
                                                   placeholder ─▶ egress swaps it
```

## Saving

`PUT /api/me/model` with `{ connections }` saves the person's whole list, in order, and answers `202 {}` once
`model/Put` started; the rows arrive in the shape. A saved connection the body leaves out is removed.

```json
{
  "connections": [
    { "kind": "claude_subscription", "key": "sk-ant-oat…" },
    { "id": "…", "kind": "api_key", "protocol": "openai-chat", "baseUrl": "https://api.openai.com",
      "models": { "implement": "gpt-6.1-sol" } },
    { "kind": "moonshot", "key": "sk-…", "active": false }
  ]
}
```

- **Connections:** 1 to 16 (`MAX_CONNECTIONS`). At most one active each of `claude_subscription`, `codex_subscription`
  and `jev`.
- **Credentials:** a connection without `key` keeps its saved one only when its id, kind, protocol and base URL are
  unchanged, refused `key_required` otherwise: a saved credential never moves host unless the person types it again. A
  Codex connection carries no key here; its link saves it.
- **Claude token:** must start `sk-ant-oat`, else `invalid_token`. It may name a base URL, its `ANTHROPIC_BASE_URL`, and
  the token then goes to that host alone.
- **Who:** anyone signed in, in person: it is their key (ruling AUTH-8, decision [0122](../decisions/0122-who-may-ask.md)). An agent, flow, frame or sandbox acting for them is refused
  `forbidden` and counted (`smithers_person_only_refusals`, act `model`): the key would pass through them.
- **Protocol:** `openai-chat` (OpenAI-compatible Chat Completions, `<base URL>/v1/chat/completions`) or
  `anthropic-messages` (Anthropic-compatible Messages, `<base URL>/v1/messages`). Model kinds only.
- **Base URL:** `https:` to one public DNS name: no IP address, single label (`localhost`), port, user, query or
  fragment, at most 512 characters. Its host is lowercased and its trailing slashes and one trailing `/v1` dropped:
  `https://api.openai.com/v1` is `https://api.openai.com`, `https://openrouter.ai/api/v1` is `https://openrouter.ai/api`.
- **Model:** the provider's model id: 1 to 81 letters, digits, `.`, `_`, `/`, `:` and `-`, starting with a letter or
  digit, trimmed. Model kinds only.
- **Key:** 16 characters to 16 KiB of text with no control character (`@smthrs/secrets` `Binding.valueProblem`, and at
  least 16 characters so the four the browser sees again are a small part of it). The browser and ChatApi check a save
  with the same rules (`checkSave` in `src/features/personal-model/contract.ts`).
- **Sealing:** AES-256-GCM under SECRETS_KEY's sealing key, the one repository secrets use, with `person:<id>`, `model`
  and the key's version as the authenticated context: a ciphertext moved to another person's row doesn't open. The
  route seals before the flow starts, so the flow's payload and journal hold only ciphertext. A save clears the last
  refusal.
- **Refusals** answer `{ code }`: `authentication` 401, `forbidden` 403, `invalid` 400, and `invalid_protocol`,
  `invalid_base_url`, `invalid_model`, `invalid_token`, `too_short`, `too_long`, `control_character`, `malformed_text`,
  `key_required` 400, `too_large` 413 (over 192 KiB), `off` 503 (no SECRETS_KEY), `unavailable` 503. A link answers
  `link_expired` or `link_refused`.

`DELETE /api/me/model` removes the whole list through `model/Delete` and answers `202 {}`: anyone signed in removes
their own, whatever their role, and the agent may for them.

`model/Put` (step `model/Store`) and `model/Delete` (step `model/Erase`) run on the Cloudflare host (`FlowExecution`).
Each writes the rows and its `personal_model_events` record in one transaction under its invocation key, so a step run
again records nothing twice. A kept connection that was removed or moved meanwhile writes nothing (`stale`). A database
failure is `StoreUnavailable`, retried for up to 30 minutes.

Connection writes share a per-person transaction lock, including when the list is empty. A Codex link carries the
latest deletion event id observed before requesting its device code. Its Keep step compares that generation under
the same lock before inserting a credential: a later deletion cancels it (`stale`), including deletion of an empty
list. A legacy link without a generation is stale. Replaying a previously committed Keep only returns `repeat` and
never recreates a deleted credential. No new table or read-path query is needed. SQL spans measure one added link
admission query, one added transaction lock for each list writer, and one generation query for Keep.


## Reading

`GET /api/shapes/personal-model` syncs the person's own rows, never another's: `PERSONAL_MODEL_SHAPE_COLUMNS`, which
never include the ciphertext. Signed out, no rows.

## Tiers

Each role maps to a tier ([model endpoint](model-endpoint.md#tiers)): `agent`, `renderer`, `judge` and `summary` to
`fast`, `coding` to `implement`, `review` and `plan` to `hard`. A tier's model, `resolveTier` in
`src/features/personal-model/contract.ts`, is for each tier of its fallbacks in turn the model the first active connection
names for it, else the tier's first preset at an active connection's host:

| Tier | Falls back to | Presets, first saved key wins |
|---|---|---|
| `fast` | `implement`, then `hard` | `claude-haiku-4-5` at `api.anthropic.com`, `gpt-6-luna` at `api.openai.com` |
| `implement` | `hard`, then `fast` | `gpt-6.1-sol` at `api.openai.com`, `claude-sonnet-5` at `api.anthropic.com` |
| `hard` | `implement`, then `fast` | `claude-opus-5-5` at `api.anthropic.com`, `gpt-6-astra` at `api.openai.com` |

So one model saved answers every tier, and two keys on the providers' own hosts need no model named. A key at any other
host (a gateway, a self-hosted server) needs some model named. The presets are data (`TIER_PRESETS`); no code branches
on a provider.

## Answering

The model endpoint opens the asker's model before every call (`worker/personal/Models.ts`, `PersonalModels`): their row,
the key opened under SECRETS_KEY, planned by `@smthrs/rpc`'s `ConfiguredModel.planModelBinding` with the key pinned to
the base URL's origin, and built by `@smthrs/model-host`'s `toModel`, whose transport refuses redirects. An
OpenAI-compatible key at `api.openai.com` reaches a model that takes a reasoning effort (`gpt-5`, `gpt-6`, `o`-series)
through OpenAI's Responses API (`/v1/responses`, `wireOf`), with the same key and origin: Chat Completions refuses
function tools beside a reasoning effort for those models, so every agent turn and a TODO's run failed there. Other
models and other hosts speak the protocol the key was saved under.

- **Everything they cause, by tier.** Every role a person's calls name goes to its tier's model among their keys:
  `agent`, `renderer`, `judge` (Jev and the memory opening's judge) and `summary` (the timeline's summaries, which their
  tab asks for as they view a conversation, a shared branch's included) on `fast`; `coding` (their `todo` runs) on
  `implement`; `review` (their TODO's review) and `plan` (drafting a flow) on `hard`. The role's reasoning effort is set
  on the call (`judge` and `summary` low, a heavy chat turn high). The model id is theirs; the request bounds
  (messages, caps, body size) are the endpoint's. Decision 0099 replaced 0096's amendment, under which summaries stayed
  on the deployment's model.
- **Outside the budget.** The call reserves nothing against `MODEL_DAILY_TOKEN_BUDGET`, writes no `model_usage` row and
  starts no spend alert. It writes a `personal_model_usage` row before the model runs, settled when it ends with the
  tokens the model reported, its outcome, its failure's code and the provider's status. A settle Postgres refuses is
  logged and counted (`smithers_personal_model_usage_errors`) and leaves the row unsettled, as the deployment's ledger
  does; a test cancelled while the provider answers settles as `interrupted`.
- **No fallback to the deployment.** A saved model that can't be used here (its key doesn't open, SECRETS_KEY is unset,
  no tier resolves to a model) is `409 no_route`, "Your model can't be used. Save it again in Settings.", logged
  `own_unusable:<reason>` (`key`, `off`, `no_model` or the planner's code). Postgres that can't say is
  `503 provider_internal`.
- **A refused key.** A provider's 401, 402 or 403, or a 429 that says the key ran out (`quota_exceeded`,
  `out_of_credit`), fails the call and sets that key's `failure_status` and `failed_at`, never the other key's; a later successful call, a
  passing test or a new save clears them. Only a call made with the row's current key marks it, so a slow call on a key
  the person has since replaced says nothing of the new one. A plain rate limit marks nothing. Quota and credit refusals
  (HTTP 402, `quota_exceeded`, `out_of_credit`) lose their retry hints (`final` in `worker/ModelRefusal.ts`), so the browser's
  model step and a `todo` run fail at once instead of parking; the model package's request executor never retries
  them. A plain rate limit (429 without a quota code) keeps its hints and is waited out as before.

### Todo runs

A `todo` run's agent calls the `coding` seat in process (`ModelEndpoint.local`). The seat reads the run it is called in
(`FlowRuntime.FlowInstance`), and `TodoMachine.ownerOf` its committer from `todos.created_by`; that person's model answers
it exactly as their endpoint calls are answered, so the run works on their key while every device is off.

### Triage

A repository's triage run (`triage/Run`, [issues](issues.md#triage)) calls the `judge` seat in process for the person
who enabled triage (`triage_settings.enabled_by`): their model decides each new issue on its `fast` tier, as it answers
their own calls, and the deployment's only when they are a Member or above of its own repository (ruling AUTH-8). So a
Maintainer with a model of their own may enable triage on any repository they maintain (`worker/github/Api.ts`,
`personal/Store.ts` `hasModel`).

## Subscriptions

`todo/Route` reads who writes an attempt once, from the committer's list (`codingChoice`): down the active connections,
the first subscription, or the first connection that serves `implement` itself. A subscription runs the vendor's
official agent in the attempt's box, in `todo/ImplementCli`: one `sandbox/Command` job, up to 40 minutes, parked on and
collected as the Smithers agent's commands are. `todo/Collect` publishes what it wrote the same way. Chat and every other
role never use a subscription.

```
wake ─ Subscriptions.of(person) ─ placeholder minted for this guest ─ kept with the box
agent ─ Authorization: Bearer <placeholder> ─▶ box egress ─ host in the subscription's hosts?
          yes ─▶ open the sealed row for this request ─ swap ─▶ api.anthropic.com or chatgpt.com
          no  ─▶ the box's ordinary egress, placeholder untouched
```

- **Only the committer's commands** get the placeholder: another person's shell in the box doesn't (`sessionAs`).
- **Repository secrets** stay usable on the same host: the box's policy is its repository's plus the credential.
- **Refusals.** Only a request that used the credential says anything of the connection: a vendor's 401, 402 or 403
  marks it, a success clears it. A box's other traffic to that host never does.
- **Codex tokens** are refreshed in the Worker before a Codex run, when under `FRESH_FOR_MS` from expiring, and on Check
  Access, one at a time per person (the row is held). The answer is sealed at once, since refresh tokens rotate, and
  any status OpenAI refuses a refresh with marks the connection. The box's `auth.json` holds the placeholder.
- **Records.** Log and span `todo.agent_cli` (agent, outcome, exit code, duration, tokens Claude Code reports), span
  `secrets.egress.subscription`, and `secret_events` under the name `connection:<id>`: never a credential.

## Testing

`POST /api/me/model/test?connection=<id>` is Check Access on one connection, by its kind: a Jev judgment, a Codex token
refresh, or one tiny real call on its first model (`Reply with the single word: ok`, 64 output tokens, 30 seconds at
most), kept in the ledger with role `test`. With no `id` it tests each key the tiers use. It answers `200` with one `TestResult`: `{ ok: true, latencyMs, sample }`
(the model's first 80 characters), or `{ ok: false, latencyMs, code, status, host }`:
the `ModelError` code (`unusable` for a saved model that can't be used here), the provider's HTTP status or `null`, and
the provider's host. Nothing saved is `404 none`; anyone signed in may test their own.

`e2e/subscriptions.spec.ts` proves each subscription against a deployment: it adds the connection in Settings, commits a
TODO on the scratch stack, checks the run took `todo/ImplementCli` and not `todo/Implement`, and reads the pull request's
one-line `NOTES.md` change on GitHub. Claude needs `E2E_CLAUDE_SUBSCRIPTION_TOKEN` (what `claude setup-token` printed).
Codex's device code needs a person signed in to ChatGPT, so a person links Codex once in Settings and the run sets
`E2E_CODEX_SUBSCRIPTION=linked`; the spec Checks Access on it first. Run it with `--project=deployment`: each browser
project opens its own pull request.

## The Settings section

`/app/settings`, the header's Settings link, shows **Your model** to anyone signed in: one row per connection, in order,
with its kind, its key's last four characters, Active, Move up, Move down, Test and Remove, and its last refusal with
when it happened. **Add** offers the five kinds. Claude's form shows `claude setup-token` with a copy button and takes
the token. Codex's shows the code, Copy code and Open OpenAI, and waits; the connection arrives in the shape. An API key
takes protocol, Base URL, key and the tiers' models. A key is read from the form once, held `Redacted`, sent in one
`PUT`, and never kept on the device: not in a collection, the outbox, a browser flow's journal or a record.

## Flows

| Flow | Where | Who | What |
|---|---|---|---|
| `model/Put` | Cloudflare host | the route, for the person in person | writes the sealed model and its audit |
| `model/Delete` | Cloudflare host | the route | deletes the model and records it |
| `model/CodexLink` | Cloudflare host | the route, for the person in person | polls the device code and seals the tokens |
| `todo/Route`, `todo/ImplementCli` | a `todo` run | the run | who writes it, and the vendor's agent in the box |
| `model/test` | the device | the person, or the agent | `POST /api/me/model/test` |
| `model/remove` | the device | the person, or the agent after the person approves | `DELETE /api/me/model` |

## Postgres

`db/migrations/0056_personal_models.ts`, `0065_model_tiers.ts` (which kept each saved model as its person's `fast`
model, so every tier falls back to it) and `0075_model_connections.ts`:

| Table | Columns | |
|---|---|---|
| `personal_models` | `person_id` and `id` (key), `kind`, `position`, `active`, `protocol`, `base_url`, `fast_model`, `implement_model`, `hard_model`, `ciphertext`, `nonce`, `key_version`, `key_last4`, `failure_status`, `failed_at`, `updated_at` | one person's ordered connections; the failure is set and cleared together; one active row each of the single kinds |
| `personal_model_events` | `id`, `person_id`, `action` (`set`, `replace`, `delete`), `invocation_key` (unique), `at` | the audit of `model/Put` and `model/Delete` |
| `personal_model_usage` | `invocation_id` (key), `request_id`, `person_id`, `role`, `model_id`, `protocol`, `connection_id` (the connection that answered), `tier` (the tier that answered; none for a test), `input_tokens`, `output_tokens`, `outcome`, `error_code`, `http_status`, `settled_at`, `created_at` | the person's ledger, apart from the deployment's |

## Observability

Counters `smithers_personal_model_requests` (op, outcome), `smithers_personal_model_shape_requests`,
`smithers_personal_model_writes` (op, change), `smithers_personal_model_calls` (role, outcome),
`smithers_personal_model_tokens` (role, type) and `smithers_personal_model_usage_errors` (op); log lines
`personal_model.request`, `personal_model.write`, `personal_model.call` (a failed or interrupted call: role, outcome,
code, the provider's status) and `personal_model.usage`; spans `personal_model.request` and `personal_model.write`. They
carry ops, outcomes, codes, statuses, roles and counts: never a key, a base URL, a model id or a prompt.

## Tests

- `worker/personal/Connections.test.ts`, `Contract.test.ts`, `Agents.test.ts`: the list, routing, every kind, the device
  link and its refresh, Check Access. `worker/secrets/SubscriptionEgress.test.ts`: the swap, its hosts, a refusal
  marking the row. `worker/personal/AgentCli.docker.test.ts`: the official CLIs in the real image, holding a placeholder,
  against the vendors' wires scripted at the network. `src/features/jev/own.test.ts`: a person's own Jev.
- `worker/personal/PersonalModels.test.ts` on the compose Postgres and Electric, with `model/Put` and `model/Delete` on
  the Node host's engine and the person's provider scripted at the network (`worker/personal/test/provider.ts`): saving,
  replacing and removing, every refusal, the person-only refusal of an agent, the shape's rows and columns, the test's
  ok, refused, out-of-quota, timed-out and unusable answers, two keys tested once each with the first failure answered,
  the endpoint answering every role with the person's model, summaries included, each role on its tier's model across
  two keys at its effort (a heavy chat turn high, Jev and summaries low), `MODEL_ROLE_TIERS` moving a role and a bad
  value keeping the defaults, a refusal marking only its key, `no_model`, keys kept without their value, presets with no
  model named, `key_required`, `no_key`, `no_model` and `stale`, and hosted inference off refusing a person who saved none
  outside the budget and without a spend alert, another person still on the deployment's, a refused key failing at
  once with no fallback and no retry, `409` for a key that doesn't open, `503` for Postgres, a `todo` run's coding seat
  on its committer's model, and a sentinel search for the key in every table, the flow journal and everything
  recorded.
- `worker/PersonOnly.test.ts`: `PUT /api/me/model` refuses an agent, a flow and a frame.
- `db/Database.test.ts`: `0056_personal_models`' tables and their rules; `0065_model_tiers` keeping a saved model as
  the fast model, two protocols per person, and the tier and ledger columns' rules.
- `src/features/personal-model/`: the Settings section and the two browser flows against ChatApi's real
  handler.
- `e2e/personal-model.spec.ts`: a real provider, saved with Fast and Implement named, shown again after a reload with
  Hard's resolved placeholder, tested, asked and removed in the browser, locally and in production.

An unnamed tier labels its fallback as `Default: <model>` so the placeholder cannot be mistaken for a saved model.

### Testing edits

Test validates the on-screen form with Save's `checkSave` before dispatching anything. A valid draft that differs
from the synced configuration says **Save first**; it never tests a different, saved configuration on behalf of the
draft. Typing any key requires saving, even if its last four characters match. Only an unchanged configuration
runs the existing durable `model/test {}`. No draft key enters a collection, flow, journal, log or metric; refusals
record only their code through `personal_model.test` and `smithers_web_personal_model_writes`.


Each model tier has one purpose label and one unique description id: Fast is
**Chat**, Implement is **Coding**, Hard is **Plans and reviews**. The same text
visibly labels its model and supplies that input's accessible description.
