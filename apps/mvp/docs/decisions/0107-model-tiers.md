# 0107: Model tiers: fast, implement and hard, across a person's own keys

2026-10-25. Accepted.

Will, 2026-10-25 (Telegram):

- 18:00 "Most calls for cost reasons especially ux related ones that do t need arbitrary text should be using Jev.
  Anything else should be Luna if we need cheap text but we should be frugal with Luna and use better models almost
  exclusively as background agents for things like writing code or intelligence constrained stuff like making a plan.
  But heavy Luna high"
- 18:01 "We should byok Claude and codex btw if we have Claude we prefer haiku. Sol should be main implementation agent
  and use Claude mostly when things seem difficult and as review"
- 18:01 "This of course should be configurable but we need good defaults"
- 18:02 "We use haiku or Luna low for Jev replacement if no Jev"
- 18:02 "I think I've been clear enough where now you can use your best judgement to figure out all the rest of the
  details"

Until now a person saved one model ([0096](0096-personal-models.md)) and it answered every role. Bring-your-own-key is
the release path ([0099](0099-hosted-inference-flag.md)), so a person's own keys decide what Smithers costs them.

## Decision

1. **Three tiers.** `fast` (cheap text and Jev's judgments), `implement` (the `todo` run's coding agent) and `hard`
   (plans and reviews). `MODEL_TIERS` and `TIER_FALLBACKS` in `src/features/model/contract.ts`.
2. **One key per protocol.** A person saves up to two keys, an OpenAI-compatible one and an Anthropic-compatible one,
   each with its base URL (`personal_models` keyed by person and protocol). Each tier names a model on one of them, or
   none.
3. **Presets for a tier left unnamed.** `TIER_PRESETS` (`src/features/personal-model/contract.ts`) lists, per tier,
   models on a provider's own host, first match wins:

   | Tier | Anthropic-compatible at `api.anthropic.com` | OpenAI-compatible at `api.openai.com` | Order |
   |---|---|---|---|
   | `fast` | `claude-haiku-4-5` | `gpt-6-luna` | Anthropic first ("if we have Claude we prefer haiku") |
   | `implement` | `claude-sonnet-5` | `gpt-6.1-sol` | OpenAI first ("Sol should be main implementation agent") |
   | `hard` | `claude-opus-5-5` | `gpt-6-astra` | Anthropic first ("use Claude ... when things seem difficult and as review") |

   The presets are data: no code path branches on a provider or a model id. A key at any other host (a gateway, a
   self-hosted server) needs its models named.
4. **Fallbacks.** A tier with neither a named model nor a preset uses the next tier of `TIER_FALLBACKS`: `fast` then
   `implement` then `hard`; `implement` then `hard` then `fast`; `hard` then `implement` then `fast`. So one model saved
   answers every tier, and a save is refused (`no_model`) only when no tier resolves.
5. **Roles map to tiers in one place** (`worker/ModelTiers.ts`, `ROLE_TIERS`), changeable without code through
   `MODEL_ROLE_TIERS` (a JSON object of roles to `{ tier, reasoningEffort?, heavyReasoningEffort? }`):

   | Role | Tier | Effort |
   |---|---|---|
   | `agent` (chat) | `fast` | the request's; `high` on a heavy turn ("heavy Luna high") |
   | `renderer` (views) | `fast` | the request's |
   | `judge` (Jev, the memory opening, triage) | `fast` | `low` ("haiku or Luna low for Jev") |
   | `summary` (timeline labels) | `fast` | `low` |
   | `coding` (`todo` run) | `implement` | the request's |
   | `review` (a pull request's review) | `hard` | the request's |
   | `plan` (drafting a flow) | `hard` | the request's |

   A turn is heavy when the agent has used a tool since the person's last message: it is working through a task, not
   answering in conversation. The model package sets the effort only where the protocol carries it (`reasoning_effort`
   on OpenAI-compatible Chat Completions, `output_config.effort` on Claude models that accept one) and drops it for an
   Anthropic model with no effort control. A model record that sets its own effort wins.
6. **Two new roles.** `review` (`checks/Review`, until now the `judge` role) and `plan` (`flow/new/draft`, until now the
   `agent` role), so a free-text code review and a plan run on `hard` while Jev's labels stay on `fast`. With no
   setting of their own, the deployment answers them with the `judge` and `agent` roles' settings, as before.
7. **Hosted inference gets the same mapping.** With the flag on, a role without an admin's setting answers with its
   tier's model in `TIER_MODELS` (a JSON object of tiers to model records), after `SUMMARY_MODEL` for the summary role
   and before the row of the role it inherits from; then `CHAT_MODEL`. Unset, nothing changes.
8. **Settings stays one form.** Each protocol's Base URL and Key, then Fast, Implement and Hard: a model id and which
   key. An empty key field keeps the saved key at the same base URL; a saved key moves to another base URL only when
   typed again (`key_required`). A save replaces the whole configuration, so clearing a key's base URL removes that
   key. Placeholders show what an unnamed tier resolves to.
9. **Existing rows migrate unchanged** (`db/migrations/0065_model_tiers.ts`): a saved model becomes the person's `fast`
   model, and every tier falls back to it.

## The audit: every model call the app makes

| Call site | Role | Output | Tier | Jev |
|---|---|---|---|---|
| `src/features/agent/flows.ts` `chat/Respond` | `agent` | the chat answer (free text), and its context compaction | `fast` (heavy: high effort) | no: free text |
| `src/features/agent/memory.ts` `chat/Opening` | `judge` | which memories and skills reach the prompt | `fast`, low | already Jev (`Relevance.judge`) |
| `src/features/jev/steps.ts` `app/jev/classify` | `judge` | yes, no, a label or unsure per item | `fast`, low | already Jev (`Classifier`) |
| `src/features/jev/steps.ts` `app/jev/evaluate` | `judge` | yes, no or unsure per criterion | `fast`, low | already Jev |
| `worker/github/Triage.ts` issue triage | `judge` | accept, reject or abstain | `fast`, low | already Jev (`Classifier`) |
| `src/features/views/steps.ts` `ui/render/write` | `renderer` | a view's TSX module | `fast` | no: code |
| `src/features/timeline/steps.ts` | `summary` | a 1 to 8 word label | `fast`, low | no: short free text |
| `src/features/flows-ui/flows.ts` `flow/new/draft` | `plan` (was `agent`) | a flow's draft: a plan that becomes code | `hard` | no: a plan |
| `src/features/flows-ui/flows.ts` `flow/run/agent` | `agent` | a person's flow's agent step | `fast` | no: free text |
| `worker/flows/Checks.ts` `checks/Review` | `review` (was `judge`) | Markdown findings on a pull request | `hard` | no: free text |
| `worker/flows/TodoAgent.ts` `todo/Implement` | `coding` | code edits through sandbox tools | `implement` | no: code |
| `worker/personal/Api.ts` Test | none (ledger role `test`) | one word | each key the tiers use, once | no: it tests the key |

Every call whose answer is a closed set (a label, a yes or no, a state the UI shows or routes on) already runs through
Jev. No call asks for free text and parses a closed answer from it, so no call moved to Jev. The `checks/Review` prompt's
"No findings." sentinel is read by nobody; the review is posted either way.

## Not done now

- **Escalation.** A `todo` run doesn't yet move from `implement` to `hard` when its task proves difficult; `hard`
  answers reviews and plans. The tier and its keys are in place for it.
- **A dedicated Jev model.** Jev's judgments run on `fast` at low effort. A tier of its own needs no new code path:
  `MODEL_ROLE_TIERS` can point `judge` at any tier.
- **More than one key per protocol.** Two gateways speaking one protocol (two OpenAI-compatible keys) wait for a
  person who needs them.

## Consequences

- Chat, views, summaries and Jev spend the cheap model; code and plans spend the stronger ones, on the person's own
  keys.
- The ledger (`personal_model_usage`) records each call's key protocol and tier, and a refusal marks only the key that
  was refused.
- A `review` or `plan` setting is new for an Admin (`admin/SetModel`); without one, the deployment behaves as before.
