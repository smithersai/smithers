# The metered model endpoint

Every model call the browser's agent makes goes through one server endpoint, `POST /api/model/<role>` on ChatApi. The endpoint refuses callers who may not ask Smithers and answers with the person's own models when they saved a key ([Your model](personal-model.md#answering)): each role with its [tier](#tiers)'s model among their keys, their timeline summaries and TODO runs included, outside the deployment's budget. That is how Smithers answers. The deployment's own model ("hosted inference", below) answers anyone else only while an Admin or the Worker's environment turns it on; then the endpoint holds the provider key, picks the role's model, reserves each call's worst case against the deployment's budget and settles it to what the call spent. Decisions: [0011](../decisions/0011-the-agent-runs-in-the-browser.md) §3, [0004](../decisions/0004-agent-ui-codemode-and-rendering.md) question 2, [0008](../decisions/0008-auth.md) §11, [0096](../decisions/0096-personal-models.md), [0107](../decisions/0107-model-tiers.md).

## Hosted inference

**A work in progress, off for a deploy, not released or documented for users until after the initial release** (Will, 2026-10-25 13:28 PDT; [decision 0099](../decisions/0099-hosted-inference-flag.md)). Everything below about roles, the budget and the deployment's models applies only while it is on.

- **The flag:** the Admin's `hosted_model` row, read on every call, set with `admin/SetHostedModel { enabled }` (an Admin acting in person; an agent acting for one is refused `delegated`, anyone else `not_admin`; each change recorded in `hosted_model_changes`, once per step). Without a row, `HOSTED_MODEL_ENABLED` decides: off unless set, on under `alchemy dev` so a laptop and the scripted end-to-end tests answer.
- **Off:** a call the person's own model doesn't answer is refused `409 no_route`, "Add your model in Settings to ask Smithers.", logged `model.endpoint` with `errorCode: hosted_off`, before any model, reservation or spend alert. On, the same refusal answers anyone who isn't a Member or above of `GITHUB_REPOSITORY`, logged `hosted_members_only` (ruling AUTH-8). A server flow's call nobody owns is refused the same way. `GET /api/auth/session` says `hostedModel: false` to a signed-in person, so the composer of a person who saved no model shows "Add your model" and a button to Settings instead ([chat](chat.md)); the triage switch reads "Triage off: needs hosted model".
- **A setting Postgres can't read** refuses the call `503 provider_internal`; the session says `hostedModel: true`, so the composer shows and the answer fails visibly.

## How it works

```
browser agent (a durable ModelStep) ── ModelProxy.layerClient ── POST /api/model/agent ──▶ ChatApi
  ChatApi: ModelProxy.serve
    prepare:  Sessions.resolve ─ none ──▶ 401 authentication
                                └ no model of their own, not a Member of GITHUB_REPOSITORY ──▶ 409 no_route
              bound the request ─ bad ──▶ 400 invalid_request      (over MODEL_MAX_REQUEST_BYTES: 413, before prepare)
                (caps: maxTokens a whole number above 0, thinkingBudget one of at least 0)
              role ──▶ tier and effort                (ModelTiers: ROLE_TIERS, MODEL_ROLE_TIERS)
              personal_models[person] ─ keys ──▶ the tier's model among them, its key, their ledger, no budget
                                       └ can't be used ──▶ 409 no_route   (never the deployment's model)
              hosted inference off ──▶ 409 no_route "Add your model…"   (hosted_model row, else HOSTED_MODEL_ENABLED)
              model_roles[role] ─ row ──▶ HostModel.make(row) ─ unusable ──▶ 409 no_route
                                └ none ─▶ summary: SUMMARY_MODEL ─▶ TIER_MODELS[tier] ─▶ the inherited role's row
                                          ─▶ HostModel (CHAT_MODEL); summary: 409 no_route
                the record's reasoningEffort, else the role's ──▶ set on the call
              reserve bytes + caps, one statement:
                today's committed ≥ budget ──▶ 429 quota_exceeded
                else committed += reservation; model_usage row by the invocation id, expiring in an hour
    model.stream ──▶ provider            (the key stays in the Worker; the record's extraBody rides the body)
    onEnd:    settle, one statement, runs to its end   (before the terminal line)
                ended normally, both counts reported ──▶ committed += spent − reservation
                anything else (failed, cancelled, a count missing) ──▶ the reservation stays, or what was reported if more
                after the reservation expired ──▶ nothing changes: it stays charged in full
              the row keeps how it ended: outcome, error code, HTTP status
  ◀── NDJSON model events, then {"type":"end"} or {"type":"error",code,...}
```

- **The SDK does the HTTP.** `ModelProxy.serve` from `@smthrs/model` reads the request, runs the app's `prepare`, streams the events and observes the call. The browser's agent reads it with `ModelProxy.layerClient`, a `Model` like any other. See [Proxy a model](../../../../packages/smithers/agent/model/docs/guides/proxy-a-model.md).
- **The call is durable in the browser, not here.** A model call is a durable step in the browser's engine; this endpoint serves one attempt of it. A crash mid-call runs that call again on resume, and a sealed result is never fetched again ([0011](../decisions/0011-the-agent-runs-in-the-browser.md) §3).
- **Code:** `worker/ModelEndpoint.ts` (the handler and its policy), `worker/ModelTiers.ts` (each role's tier and effort), `worker/ModelRoles.ts` (role lookup and `set`), `worker/ModelUsage.ts` (the budget's reservation and settle), `worker/SetModel.ts` (`admin/SetModel`), `worker/Actor.ts` (who is acting, and `canAsk`, who may ask; sign-in in `worker/SignIn.ts` provides the actor), and the route in `worker/Chat.ts`. The route and role names the browser shares are in `src/features/model/contract.ts`.

## Sign-in

Signed-out people can't ask Smithers ([0008](../decisions/0008-auth.md) §11). Anyone signed in is answered by their own model, whatever their role: where they may ask, ChatApi decides by their role on each conversation's repository (ruling AUTH-8, decision [0122](../decisions/0122-who-may-ask.md)). The deployment's own model answers only a Member or above of `GITHUB_REPOSITORY`, the session's role, whose spend its owner pays; anyone else without a model of their own is refused `409 no_route` "Add your model in Settings to ask Smithers.", logged `hosted_members_only`, even while hosted inference is on. A server flow's call on behalf of a person (a `todo` run's) is answered by the deployment's model only when a live session of theirs holds that role (`SessionStore.deploymentMember`). No refusal calls the model or meters anything. The endpoint reads who is asking through an injected service, `Sessions`, whose `resolve` gives the request's `Actor` or none; [sign-in](sign-in.md) provides it from the session cookie.

- **Production:** sign-in's sessions. Until the GitHub App is configured (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`), nobody is signed in, and every call is refused with `401` and code `authentication`.
- **Local development:** under `alchemy dev`, `alchemy.run.ts` declares `worker/DevChatApi.ts` in place of `worker/ChatApi.ts`: the same program, with a local developer signed in as an Admin while the GitHub App isn't configured; the developer can sign out (the dev signed-out cookie), and is then refused `401` like anyone signed out ([sign-in.md](sign-in.md#local-development)). A deploy bundles `worker/ChatApi.ts`, which never imports it.
- **Tests** provide an actor through a layer (`signedIn(actor)` in `worker/test/harness.ts`), or sign-in's own sessions (`worker/test/signIn.ts`).
- Sessions that can't be read (Postgres unreachable) are `503` with code `provider_internal`, not a sign-in prompt.
- An `Actor` is a person (`subject`), their role on the repository (Admin, Maintainer, Member or Guest, or none; [0007](../decisions/0007-roles-and-tags.md) question 1), and `act` when an agent, flow or sandbox acts for them.

## The request

The caller chooses the conversation, its system prompt and its tools; the endpoint bounds the rest.

| Field | What the endpoint does |
|---|---|
| `modelId` | replaced by the role's model |
| `messages` | at least 1, at most `MODEL_MAX_MESSAGES`; otherwise `400` |
| `serverTools` | refused with `400`: provider-run tools spend on the deployment's account |
| `params.maxTokens` | a whole number above 0, else `400`; at most `MODEL_MAX_OUTPUT_TOKENS`; that value when unset |
| `params.thinkingBudget` | a whole number of at least 0, else `400`; at most `MODEL_MAX_OUTPUT_TOKENS` |
| everything else | passed through: `system`, `tools`, `toolChoice`, `cacheKey`, `cacheBoundary` and the other `params` |

Both caps feed the reservation, so a negative or fractional one would shrink it while the provider still spends: eight calls at once with a thinking budget of −8,000 once passed a budget of 20,000 and spent 64,800 tokens (Opus review 4, P2-1). The endpoint refuses them, and reserves from the clamped values.

The body is at most `MODEL_MAX_REQUEST_BYTES`, 192 KiB unless set, counted while it is read; a larger one is `413` and never reaches `prepare`. That bound is the prompt's token cap as well: a byte-level tokenizer never yields more tokens than bytes of text, every part a `ModelRequest` carries is text, and the reservation below counts each byte as a token. The default leaves room for the agent's own window: it compacts against 32,768 tokens (`CONTEXT_WINDOW_TOKENS` in `src/features/agent/host.ts`), about 128 KiB of text, and its JSON body adds field names and escapes.

## Roles

Each model call names its role: `agent` (chat, and a person's flow's agent steps), `coding` (the `todo` run's agent), `renderer` (views), `judge` (Jev, the memory opening and triage), `summary` (timeline labels), `review` (a pull request's review) or `plan` (drafting a flow). A role is answered by the model an admin set for it, read from Postgres on every call; without one, the deployment's defaults answer it, in this order:

1. `SUMMARY_MODEL`, for the `summary` role only.
2. Its tier's model in `TIER_MODELS` ([tiers](#tiers)).
3. The setting of the role it inherits from: `agent` for `coding` ([decision 0033](../decisions/0033-coding-model-role.md)) and `plan`, `judge` for `review`, so a role answers as it did before it had a name.
4. `CHAT_MODEL`, through `HostModel`; never for `summary`, which is `409 no_route` (`unusable:unconfigured`) instead.

A change applies on the next call, with no deploy.

### Tiers

Each role maps to a tier, the strength of model it needs, and to how hard that model thinks ([decision 0107](../decisions/0107-model-tiers.md)). A person's own models answer by tier ([Your model](personal-model.md#tiers)), and so do the deployment's when `TIER_MODELS` names one.

| Role | Tier | Reasoning effort |
|---|---|---|
| `agent` | `fast` | the request's; `high` on a heavy turn |
| `renderer` | `fast` | the request's |
| `judge` | `fast` | `low` |
| `summary` | `fast` | `low` |
| `coding` | `implement` | the request's |
| `review` | `hard` | the request's |
| `plan` | `hard` | the request's |

- **One place:** `ROLE_TIERS` in `worker/ModelTiers.ts`. `MODEL_ROLE_TIERS`, a JSON object of roles to `{ tier, reasoningEffort?, heavyReasoningEffort? }`, replaces a role's entry, such as `{ "judge": { "tier": "implement" } }`; a value that doesn't parse keeps the defaults and logs `model.endpoint` with `errorCode: role_tiers:<code>` once, when the endpoint builds.
- **A heavy turn** is a call in which the agent has used a tool since the person's last message: it is working through a task, not chatting. It runs at the role's `heavyReasoningEffort`.
- **Which effort wins:** a model record's own `reasoningEffort` (an admin's setting, `SUMMARY_MODEL`, a `TIER_MODELS` record), else the role's, else the request's. The role's effort is a hint: it reaches only a model that takes one, by its id after any gateway prefix (`EFFORT_MODELS` in `worker/ModelTiers.ts`: Claude models, `o1` to `o9`, `gpt-5`, `gpt-6` and `gpt-oss`), since a model such as `gpt-4.1-mini` refuses a call that carries `reasoning_effort`. Each hint is counted `smithers_model_effort_hints` (role, outcome `sent` or `dropped`). A record's or a request's own effort is sent as set. The model package sends it only where the protocol carries it, and drops it for a Claude model with no effort control.

The coding role is the seam for pointing a deployment's coding agent at a model of its own choosing: any endpoint that speaks one of the configured-model protocols (Anthropic Messages, OpenAI Responses or Chat Completions), with a key the Worker holds under a name of the deployment's own and pins to that endpoint's origin (`SMITHERS_MODEL_KEY_<NAME>` and `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`). What serves that endpoint is the deployment's business, at its own risk; the product names no vendor.

```
admin/SetModel { role: "coding", model: { protocol: "openai-chat", baseUrl: "https://models.example", modelId: "coder-1", credential: "CODER" } }
# the Worker holds SMITHERS_MODEL_KEY_CODER and SMITHERS_MODEL_KEY_CODER_ORIGIN=https://models.example
```

An admin changes a role with the flow `admin/SetModel { role, model }`. `model` is a configured-model record (`@smthrs/rpc` ConfiguredModel) without its name: `protocol`, `baseUrl`, `path`, `modelId` and `credential`. `credential` names a key the Worker already holds, such as `CEREBRAS_API_KEY`; the key itself never enters the record.

- **Who may run it:** only a person with the Admin role acting in person. An agent, flow or sandbox acting for an Admin is refused (`NotAllowed`, reason `delegated`), and so is anyone else (`not_admin`). The step decides before it writes.
- **What it writes:** the `model_roles` row and a `model_role_changes` row naming who changed it, in one transaction. A replayed step finds its change by its invocation key and leaves both the current setting and audit history unchanged, including after a newer setting.
- **Where it runs:** on any host; the host that starts it provides `CurrentActor`, never the payload. Its tests run it on the Node host. Starting it from the CLI or an admin view comes with sign-in.
- **Routing preferences: `extraBody`.** A record may carry fields the model adds to every request body it sends, beside the protocol's own: a gateway's routing preferences, which no protocol models. On the Vercel AI Gateway, `"extraBody": { "providerOptions": { "gateway": { "order": ["cerebras"] } } }` sends a model the gateway serves through several providers to Cerebras first, at Cerebras's speed, and to the others only when Cerebras can't answer; OpenRouter reads `{ "provider": { "order": ["cerebras"] } }`. The protocol's own fields win, so `extraBody` never replaces the model, the messages, the output cap or streaming. It is a JSON object of at most 2 KiB with no field named for a credential (`ModelExtraBodySchema` in `@smthrs/rpc`), refused when `admin/SetModel` decodes it; keys go in `credential`, by name. It is part of the provider's request, so it is the same on every call of the role and the provider's prompt cache holds.
- **Reasoning: `reasoningEffort`.** A record may set how hard its model thinks on every call of the role: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, sent as the protocol's own field (Chat Completions' `reasoning_effort`). A role that only labels or judges needs none: on 2026-10-25 the gateway's Qwen spent up to 1,300 output tokens on a 170-token timeline entry at its default reasoning. Absent, the caller's request decides. A provider that doesn't take the value refuses the call `invalid_request`.
- **A row the Worker can't use,** such as one naming a credential the Worker doesn't hold or one that isn't a record, makes that role's calls fail with `409` and code `no_route`. The `model.endpoint` log line names the reason (`unusable:<reason>`). It is a `409`, not a `503`, because waiting doesn't change a setting: a model step seals it as the call's answer, where a `503` was a capacity refusal the engine retried six times.

## Budget

The deployment has one budget, `MODEL_DAILY_TOKEN_BUDGET` tokens per UTC day, input and output together. Each call reserves its worst case before the model runs and settles to what it spent when it ends, so calls in flight at once can't all pass one read of the budget.

- **Reserve, in `prepare`:** the last step, after the role's model resolved, so no later refusal leaves a reservation behind. The reservation is the body's bytes (each counted as a prompt token), plus the clamped `maxTokens`, plus the clamped `thinkingBudget` when set. One statement raises today's `model_budget_days.committed` by it and writes the call's `model_usage` row, keyed by the invocation id `ModelProxy.serve` minted for the call, charged the reservation and expiring `MODEL_RESERVATION_EXPIRY` from now, only while `committed` is below the budget. When it isn't, the call is refused with `429` and code `quota_exceeded`, and the model isn't called. Postgres serializes concurrent reservations on the day's row, so against a budget of 46 tokens, eight calls at once admit exactly one.
- **The overshoot is one call's.** A call larger than the whole budget is refused, the day's first included. Any other call is refused only once `committed` reaches the budget, whatever its own size, so the last call of a nearly spent day still runs. The budget is passed by at most one call's reservation, itself no larger than the budget, never by how many calls run at once.
- **Settle, in `onEnd`:** one statement writes what the model reported to the call's row and moves its charge, and the day's `committed`, from the reservation to what it spent. Only a call that ended normally with both its input and output tokens reported settles to them (`recorded`). Any other usage is unknown, never zero: a call that failed, whose client went away, or that ended without both counts may have spent tokens nobody reported, so it keeps its reservation, or what it reported when that is more (`kept`, a `model.usage` line). Otherwise a caller could cancel each call after its output, before its usage, and spend without paying (Codex review 4, P1). The exception is a call the provider refused before producing any output, `rate_limited` or with a provider 4xx (`ModelProxy.refusedCleanly`): it spent nothing beyond what the provider reported, so it settles to that, 0 when nothing (`refused`, a `model.usage` line with its `errorCode`). A transport failure, a 5xx or a timeout before any output stays unknown and keeps its reservation. Before 2026-10-20 a refused call kept its whole reservation, about 43,000 tokens for one agent call, so 23 calls refused during a provider outage spent a 1,000,000-token day while the provider spent nothing, and every later call was `429 quota_exceeded`. Only an unsettled row changes, so settling again does nothing. The terminal line waits for the settle, so a call that starts after another ended sees its spend. `onEnd` runs to its end once it starts, even when the client goes away meanwhile ([Proxy a model](../../../../packages/smithers/agent/model/docs/guides/proxy-a-model.md)).
- **Expiry.** A reservation that never settles (its Worker died, or its settle never ran) is unknown spend too, so it stays charged in full until the day ends. Its expiry, `MODEL_RESERVATION_EXPIRY` after it reserved, makes that final: the settle statement changes only a row that hasn't expired, so a settle that comes later changes nothing (`expired`, a `model.usage` warning). No sweep runs; the statements read the expiry themselves.
- **Fail-closed.** A settle Postgres refuses is logged (`model.usage`) and counted, the answer still ends, and the call stays counted at its reservation. So does a call whose response body is never read, because `onEnd` never runs for it.
- **The ledger adds up.** Each row's `charged_tokens` is what the call counts against its day, so a day's `committed` is the sum of its rows' charges.
- **The ledger says how each call ended.** Settling writes the call's `outcome` (`answered`; `aborted`, its client went away; `refused`, its provider refused before any output; `failed`, any other failure), its model error's `error_code` and the provider's `http_status` when it answered one. On 2026-10-25, 11 of the first 40 calls to a new provider settled at 0 tokens and the ledger couldn't tell aborts from refusals. A call that never settles keeps none.
- The caller's `x-smithers-request-id` is kept beside the invocation id to correlate, never as the key, because a caller may send one id on any number of calls and each one runs the model.

Tokens are also counted in the `smithers_model_tokens` metric, by `role`, `model` and `type` ([observability.md](../observability.md#model-endpoint)). Each metered call also records what it spent, in tokens and estimated dollars by role and model, and each admitted call starts its window's spend alert to the Admins ([spend-alerts.md](spend-alerts.md)).

## Errors

Every refusal is a JSON body `{ code, message, requestId }` with a `ModelError` code. A failure after the stream started is the terminal line `{ "type": "error", code, message }`, whose message is a fixed headline for its code. Neither ever carries provider text.

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | the body isn't a `ModelRequest`, or the request breaks a bound above, a cap included |
| `401` | `authentication` | nobody is signed in |
| `409` | `no_route` | the caller saved no model and isn't a Member or above of `GITHUB_REPOSITORY`, whom alone the deployment's model answers |
| `404` | none (empty) | the role isn't `agent`, `coding`, `renderer`, `judge`, `summary`, `review` or `plan` |
| `405` | `invalid_request` | not a `POST` |
| `413` | `invalid_request` | the body is over `MODEL_MAX_REQUEST_BYTES` |
| `429` | `quota_exceeded` | today's budget is spent |
| `409` | `no_route` | the role's setting can't be used here, the summary role has no model, or the person's own model can't be used here |
| `503` | `provider_internal` | Postgres couldn't be read, or a person's own call couldn't be written to their ledger |

## Postgres

A model-setting invocation claims its audit key and updates the setting in one transaction. Replaying an older invocation leaves a newer setting and its audit history unchanged.

Migrations `0004_model_roles`, `0012_model_reservations`, `0017_model_charges`, `0057_model_usage_outcome` and `0058_hosted_model`. None of these tables is synced to browsers.

| Table | Columns | |
|---|---|---|
| `model_roles` | `role` (key: `agent`, `coding`, `renderer`, `judge`, `summary`, `review`, `plan`; the last two since `0065_model_tiers`), `model` (jsonb record), `updated_by`, `updated_at` | the admin's setting per role |
| `model_role_changes` | `id`, `invocation_key` (unique), `role`, `model`, `changed_by`, `changed_at` | the audit of `admin/SetModel` |
| `model_usage` | `invocation_id` (key, the server's id for the call), `request_id` (the caller's), `role`, `model_id`, `day` (the UTC day it reserved on), `reserved_tokens`, `input_tokens`, `output_tokens` (what the model reported: 0 until settled, and for a count it never reported), `charged_tokens` (what the call counts against its day: its reservation until it settles, then what it spent, or its reservation when that is unknown), `expires_at` (when an unsettled reservation becomes final), `settled_at` (null while the call runs, and for a reservation that expired), `spend_alert_id` (the spend alert that carried the call, migration `0019_spend_alerts`, [spend-alerts.md](spend-alerts.md)), `outcome`, `error_code`, `http_status` (how it ended, migration `0057_model_usage_outcome`, above), `created_at` (indexed) | the ledger: what each served call reserved, reported and was charged, and how it ended |
| `model_budget_days` | `day` (key, a UTC date), `committed` (settled spend plus open reservations, never negative) | the budget's counter, one row per day |
| `hosted_model` | `id` (always `true`: at most one row), `enabled`, `updated_by`, `updated_at` | the Admin's hosted-inference setting |
| `hosted_model_changes` | `invocation_key` (key), `enabled`, `changed_by`, `changed_at` | the audit of `admin/SetHostedModel` |

## Configuration

| Variable | Default | |
|---|---|---|
| `MODEL_DAILY_TOKEN_BUDGET` | `1000000` | a positive integer: the deployment's tokens per UTC day, input and output together |
| `MODEL_MAX_OUTPUT_TOKENS` | `8000` | a positive integer: the most output tokens one call may ask for |
| `MODEL_MAX_MESSAGES` | `200` | a positive integer: the most messages one call may send |
| `MODEL_MAX_REQUEST_BYTES` | `196608` (192 KiB) | a positive integer: the largest request body, which is also the prompt's token cap |
| `MODEL_SPEND_ALERTS` | on; off under `alchemy dev` | whether any model spend alerts the Admins ([spend-alerts.md](spend-alerts.md#settings)) |
| `MODEL_SPEND_ALERT_WINDOW` | `15 minutes` | a duration of at least a second: one spend alert per window at most |
| `MODEL_RESERVATION_EXPIRY` | `1 hour` | a duration: how long a call's reservation lasts before it is final. The longest call the caps allow writes 16,000 tokens, about 27 minutes at 10 tokens a second |
| `HOSTED_MODEL_ENABLED` | off; on under `alchemy dev` | whether the deployment's own model answers when no Admin set the `hosted_model` row ([hosted inference](#hosted-inference)); a value that doesn't parse is off |
| `CHAT_MODEL` | Cerebras `qwen-3.8-27b` | the default model for every role without a setting but `summary`; see [chat.md](chat.md#configuration) |
| `MODEL_ROLE_TIERS` | `ROLE_TIERS` | a JSON object of roles to `{ tier, reasoningEffort?, heavyReasoningEffort? }`, each replacing that role's entry ([tiers](#tiers)); a value that doesn't parse keeps the defaults, logged |
| `TIER_MODELS` | none | a JSON object of tiers (`fast`, `implement`, `hard`) to model records: the deployment's model for each tier it names, for a role without a setting ([roles](#roles)). Captured when the endpoint builds; a malformed value is refused per call as `unusable:config` for every role without a setting |
| `SUMMARY_MODEL` | none | the `summary` role's model when no admin set one: a model record as JSON, with its own `extraBody` and `reasoningEffort` when it names them, captured when the endpoint builds so Alchemy binds it. Unset, the role has no model (`unusable:unconfigured`); a malformed value is refused per call as `unusable:config`, without failing the build |
| `ANSWER_TURN_LIVE_SECONDS` | `30` | the `agent` role's liveness bound: how long a live run of the role may go without writing its answer, read beside the roles (`src/features/model/contract.ts`); the evidence for the default is in [agent.md](agent.md#turn-by-turn) |
| a setting's credential | none | the key a `model_roles` record names, for example `CEREBRAS_API_KEY`; a custom credential `NAME` reads `SMITHERS_MODEL_KEY_NAME` and `SMITHERS_MODEL_KEY_NAME_ORIGIN` |

## Tests

`worker/ModelEndpoint.test.ts` runs ChatApi's real handler on its own schema of the compose Postgres (`pnpm db:up`). The model provider is the only scripted seam: the default model is a scripted `Model`, and a model an admin sets is a real `HostModel` reaching a scripted OpenAI-compatible provider on loopback HTTP. `admin/SetModel` runs on the Node host (`worker/test/flowHost.ts`).

- A signed-out call is refused with `401`, and a Guest's or a roleless person's without a model of their own with `409 no_route`, the deployment's model on; neither reaches a model or meters anything. Their own model answers them (`worker/personal/PersonalModels.test.ts`). A Member's call streams, and the browser's `ModelProxy.layerClient` reads it as a `Model`.
- The request bounds: model id, output tokens, thinking budget, provider-run tools, message counts, and the body's size (`413`, never reaching a model or the budget). A cap that is negative, 0 for `maxTokens`, or fractional is `400` before any reservation; eight concurrent calls with a thinking budget of −8,000 never run (the regression from Opus review 4, P2-1); a thinking budget of 0 runs.
- A role change by `admin/SetModel` applies on the next call, with the key sent only to the setting's origin; the other roles keep the default.
- Tiers: `plan` and `review` answer with the `agent`'s and the `judge`'s settings; `TIER_MODELS` answers each role without a setting on its tier, before the role it inherits from, with its record's effort; a malformed `TIER_MODELS` is `409 unusable:config`; the default model gets a judge's `low` effort only when its id takes one (`gpt-oss-120b`, not `qwen-3.8-27b`), counted sent or dropped. A person's own keys by tier are in `worker/personal/PersonalModels.test.ts` ([Your model](personal-model.md#tests)).
- An agent acting for an Admin, and a Member, can't run `admin/SetModel`, and nothing is written. A database failure fails its run as a defect (`worker/SetModel.test.ts`).
- Usage rows and `smithers_model_tokens` per role and model; calls that repeat one request id each book a row and count against the budget; `429` once today's spend reaches the budget; yesterday's spend doesn't count.
- Reservations: eight concurrent calls against a budget of 46 admit exactly one, call the model once and commit 46 (the regression from Fable review 2, P2-2); a call reserves bytes plus its caps before the model runs and settles to what it spent; a settle that runs again changes nothing; a reservation is refused only once committed reaches the budget, and one larger than the whole budget always, the day's first included; a settle Postgres refuses is logged and counted and leaves the reservation counted; a reservation Postgres refuses is `503 provider_internal` before any model.
- Clean refusals (the regression from the agent evals, 2026-10-20): a call refused `rate_limited` or with a 4xx before any output settles to what the provider reported, 0 when nothing, logged and counted `refused`; 25 refused calls against a budget of one reservation leave the next call served; a transport failure, a `503` or a timeout before output, and a `429` after output, keep their reservation. The same for a server flow's own calls (`ModelEndpoint.local`).
- Unknown usage (the regressions from Codex review 4, P1): a call cancelled after its text, before usage, and one that fails there, keep their whole reservation; partial usage, complete usage before a failure, and a report larger than the reservation keep the reservation or the report; a call that ends normally without both counts keeps its reservation; calls cancelled before usage spend the budget until the third is refused `429`.
- Expiry (Opus review 4, P2-6): a reservation that never settles counts in full, a settle after its expiry changes nothing, and admission still counts it; a call whose settle comes after its reservation expired is `expired`, logged and counted; the expiry is an hour unless set; each call's `charged_tokens` add up to the day's `committed`.
- Postgres unreachable, and a role lookup Postgres refuses, are `503 provider_internal`; an unusable setting is `409 no_route`.
- No exported log line, span or metric carries the prompt, the answer, the provider's error text or the key (a sentinel test).

The SDK's own suite (`packages/smithers/agent/model/test/ModelProxy.test.ts`) covers the wire format, the client's typed failures, cancellation, `onEnd` finishing when the client goes away while it runs, request ids, a fresh invocation id for every served call when callers repeat a request id, the `Admission` `prepare` receives: the same invocation id `onEnd` gets, and the body's bytes; and what `End` says of a failure (its code, its provider status, whether the model produced output) and which failures `refusedCleanly` reads as clean. `db/Database.test.ts` covers `0012_model_reservations`: earlier rows become settled and seed their days' counters; and `0017_model_charges`: earlier rows are charged what they settled to, or their reservation while open, and expire an hour after they were made.

The optional `summary` role is for conversation navigation. It is answered by an Admin's model setting, else by `SUMMARY_MODEL`, else by the `fast` tier's `TIER_MODELS` record, and never falls back to the main agent model. Calls use the same reservations and metering; see [timeline](timeline.md).

## Provider quota and credit

No backup provider yet: a deployment model's HTTP 402, `quota_exceeded`, or `out_of_credit` ends the answer promptly. Chat shows “Couldn't answer. Model credit or quota is used up.” and Retry. Retry asks again as a new answer after the provider's balance or quota is restored; it never silently changes providers.

The endpoint applies the same terminal-refusal normalization as personal models, dropping quota/credit cooldown hints before the browser receives them. `@smthrs/agent`'s existing terminal classification and `@smthrs/flow` policies end the model attempt without parking. A plain HTTP 429 retains its hints and existing durable backoff. The opening judge uses `RetryPolicy.retryable` to exclude quota and credit codes while retaining transient model failures, so memory selection also fails promptly. The opening judge and agent carry the quota reason into the durable answer settlement, so it survives a crash before settlement without another provider call. No app retry loop is involved.

The `model.quota.refused` span and log record the role, failure code and HTTP status; `smithers_model_quota_refusals` counts these refusals by role and code. The existing `model.proxy.serve` span and log also record the failed call; `smithers_model_proxy_requests` counts the failed call and `smithers_model_usage_writes{outcome=refused}` counts its settlement. Only codes and counts are recorded, never provider text, prompts or credentials. `ModelEndpoint.test.ts`, `agent.test.ts`, and `chat.test.ts` inject faulty model services to cover quota, credit, 402, unchanged rate-limit hints, one-call termination and Retry.
