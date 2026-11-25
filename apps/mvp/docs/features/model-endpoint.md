# Server model seats

Server flows call models through `worker/ModelSeats.ts`. Chat uses [attached agents](mcp.md). The retired `/api/model` and `/api/model/*` routes return 404. [Decision 0173](../decisions/0173-byoa-only-mcp-attach-and-jev-config.md) records the cutover.

## How it works

A durable model step prepares its request with the seat's credential-free route and seals its answer for replay. `@smthrs/agent` provides the durable model step, and `@smthrs/model-host` resolves the configured model and opens the provider key. Both uses are in the [library catalog](../../../../docs/libraries.md). The key stays in the Worker.

When a run has an owner, its saved model for the role's tier takes precedence. The call records spend in the person's ledger. A connection that can't be used fails the seat. Triage and other server workflows use their declared roles.

## Hosted inference

Hosted inference is off by default in production and on under `alchemy dev`. `HOSTED_MODEL_ENABLED` supplies the deployment default. An Admin acting in person can override it with `admin/SetHostedModel` or `POST /api/hosted-model`. Every change has a receipt in `hosted_model_changes`.

## Sign-in

A TODO can use a deployment-paid model when its owner is a live Member or above of the deployment repository. The Worker checks this with `SessionStore.deploymentMember`. A person's saved connection and a repository's selected external coding agent have their own admission paths.

## The request

| Limit | Behavior |
|---|---|
| `MODEL_MAX_REQUEST_BYTES` | Counts serialized bytes before picking the model |
| `MODEL_MAX_MESSAGES` | Bounds the number of messages and requires at least one |
| `MODEL_MAX_OUTPUT_TOKENS` | Caps output and thinking tokens |
| Provider-run tools | Refuses the call |

The prepared request uses the selected model and its effective reasoning effort.

## Roles

A deployment role first uses the current `model_roles` row. The optional `summary` role then tries `SUMMARY_MODEL`. A role without a setting uses its tier's record in `TIER_MODELS`, when present. `plan` can inherit `agent` and `review` can inherit `judge`. Other roles can use `CHAT_MODEL`. The `coding` and `summary` roles require an explicit seat. Missing deployment credentials fail calls that need them and leave the Worker available for attach.

A TODO uses its repository's selected external agent, its owner's selected Claude or Codex subscription, or an eligible personal or deployment coding seat. A missing usable seat fails the durable run with `NoSeat` and records the TODO failure. The forward migration copies the legacy `agent` model setting into `coding` when `coding` has no setting.

An Admin acting in person can set a role with `admin/SetModel { role, model }`. A model record can specify a protocol, endpoint, model id, credential name and reasoning effort. The Worker holds the named key and pins custom credentials to their configured origins. Changes apply on the next call.

### Tiers

| Role | Default tier | Reasoning effort |
|---|---|---|
| `agent` | `fast` | the request's, high on a heavy turn |
| `renderer` | `fast` | the request's |
| `judge`, `summary` | `fast` | low |
| `coding` | `implement` | the request's |
| `review`, `plan` | `hard` | the request's |

`MODEL_ROLE_TIERS` overrides per-role tiers or effort. A configured model's own reasoning effort takes precedence over its role's hint and the request's effort.

## Budget

The deployment reserves serialized request bytes plus the clamped output and thinking tokens before calling a hosted model. One Postgres statement writes the reservation and updates the UTC day's committed tokens. Calls fail with `quota_exceeded` when the day has reached its budget or when one call's reservation exceeds the entire budget.

A completed call with both usage counts settles to the reported spend. A provider refusal before output settles to reported usage, or zero when the provider reports none. Unknown usage keeps the reservation or the amount reported when it is higher. Expired reservations retain their charge. Spend alerts use the same ledger. [Spend alerts](spend-alerts.md)

## Errors

An unusable model returns `no_route`. A temporary database failure returns `provider_internal`. A TODO without a usable coding seat fails with the durable `NoSeat` error before model generation.

## Postgres

`model_roles` stores the current settings, and `model_role_changes` records changes by invocation key. `model_usage` records reserves, charges, outcomes and safe provider codes. `model_budget_days` holds daily committed totals. Personal calls use their own ledger.

## Configuration

| Variable | Default |
|---|---|
| `MODEL_DAILY_TOKEN_BUDGET` | 1,000,000 |
| `MODEL_MAX_OUTPUT_TOKENS` | 8,000 |
| `MODEL_MAX_MESSAGES` | 200 |
| `MODEL_MAX_REQUEST_BYTES` | 192 KiB |
| `MODEL_RESERVATION_EXPIRY` | 1 hour |
| `MODEL_SPEND_ALERTS` | On, off under `alchemy dev` |
| `HOSTED_MODEL_ENABLED` | Off, on under `alchemy dev` |
| `CHAT_MODEL` | Cerebras `qwen-3.8-27b` for roles eligible for the default |
| `TIER_MODELS`, `SUMMARY_MODEL` | Unset |

## Tests

`worker/ModelEndpoint.test.ts` exercises server admission, metering, configuration and public-route 404s using the real Postgres schema. `worker/flows/Todo.test.ts` exercises the typed `NoSeat` through the durable TODO run. `worker/personal/PersonalModels.test.ts` covers personal credentials and ledger settlement.

## Provider quota and credit

HTTP 402, `quota_exceeded` and `out_of_credit` terminate the model attempt. Ordinary rate limits retain their durable backoff. The `model.quota.refused` log and span and the `smithers_model_quota_refusals` counter carry safe role and failure codes.
