# 0096: A person's own model (bring your own key)

2026-10-24. Accepted.

Will, 2026-10-24 10:04, after reading the BYOK and subscriptions research report: "impleent it and get it working
please in production". The report's Recommendation A is the design brief; its Recommendation B (plan logins) waits on
Will's own decision and is not part of this.

## Decision

1. **One model per person.** A signed-in person who may ask Smithers (Member or above, decision 0007) saves one model of
   their own: a protocol, a base URL, a model id and a key. Protocols are the two the model endpoint already speaks
   with no vendor code: `openai-chat` (OpenAI-compatible) and `anthropic-messages` (Anthropic-compatible). No vendor is
   named anywhere (PROC-23's addendum): the person's endpoint, at their own risk.
2. **The key is sealed in the secrets vault.** The route seals it with AES-256-GCM under SECRETS_KEY's sealing key, the
   one repository secrets use (decision 0005 §4), with `person:<id>`, `model` and the key's version as the
   authenticated context, before `model/Put` starts, so the journal and Postgres hold only ciphertext. Nothing ever
   answers the key again: the browser sees its last four characters. It opens in the Worker's memory for one call.
3. **Where a key may go.** The base URL is `https:` to one public DNS name, with no IP address, single label, port,
   user, query or fragment (the secrets host rules), and its trailing `/v1` is dropped since the protocol's path
   follows it. The model package's planner pins the key to that origin and its transport refuses redirects. The base
   URL changes only with a key, so nobody points a saved key at another host.
4. **Whose calls it answers.** The person's chat, through `POST /api/model/<role>` (`agent`, and the `renderer` and
   `judge` calls their chat makes), and every call of a `todo` run they committed (the `coding` seat finds the run's
   committer from its execution). Timeline summaries stay on the deployment's model (the amendment below). A server
   flow that is nobody's, such as triage, stays on the deployment's model.
5. **Outside the deployment's budget.** A person's call reserves nothing, settles nothing in `model_usage` and starts no
   spend alert (AUTH-4 stays on deployment spend). It is kept in the person's own ledger, `personal_model_usage`, and
   counted by role. The request bounds (messages, caps, body size) are the endpoint's own.
6. **A refusal is final and visible.** The person's model never falls back to the deployment's. A saved model that
   can't be used here (a key that no longer opens, no SECRETS_KEY) is `409 no_route`. A provider's 401, 402, 403 or 429
   fails the call and marks the person's row (`failure_status`, `failed_at`), which their device shows as a toast and on
   the Settings page with the provider's host and status, until a later success or a new save clears it (a 429 counts
   only when it says the key ran out; a plain rate limit is a wait). Quota and
   credit refusals lose their retry hints, so no step waits out a key that ran out (`isTerminalRefusal`), and the
   server's request executor never retries them; a plain rate limit stays a transient wait.
7. **Flows.** `model/Put` and `model/Delete` are durable flows on the Cloudflare host, each one step writing the row and
   its audit once under its invocation key. In the browser, `model/test` and `model/remove` are registry flows the
   person's buttons and the agent both run (FLOW-3); `model/remove` asks the person to confirm the agent's call.
   **Saving is the person's own act, never the agent's**: the key would pass through the agent's context, its journal
   and the device, and decision 0017 lists secrets among the person-only protected acts. The Settings page sends it in
   one `PUT` in the person's own session, as the Secrets page does.
8. **Test.** `POST /api/me/model/test` makes one tiny real call (one word back, 64 output tokens) with the same opened
   model and ledger the endpoint uses, and answers ok and the model's first words, or the failure's code, the
   provider's status and its host.

## Choices the rulings didn't settle

- The person's chat uses their model for all of its calls (`agent`, `renderer`, `judge`), not only `agent` as the
  report sketched, so a deployment whose own model is out of quota still renders their views.
- Anyone signed in removes their own model, a person who lost their role included (Settings shows them Remove alone);
  saving and testing need Member.
- The failure is shown by the server's record of it (a toast and the Settings line), not in the failed chat answer,
  whose stored failure kinds are unchanged.
- The test is its own route, not a call to `/api/model/agent`, so it always tests the saved model and reports the
  provider's status, which the endpoint's NDJSON error line doesn't carry.

## Not built

A deployment switch that forbids personal keys; today's tokens and cost on the Settings page; Bedrock and Vertex (they
sign requests); plan logins (the report's Recommendation B, Will's decision).

## Library catalog

`@smthrs/model` and `@smthrs/model-host` (`toModel`) for the provider call, `@smthrs/rpc` `ConfiguredModel` for the
plan, `@smthrs/control` `WebCryptoCipher` for sealing, `@smthrs/secrets` `Binding.valueProblem` for the key's text,
`@smthrs/flow` for the durable writes, `@smthrs/effect-electric` for the shape. No new dependency.

## Amendment, 2026-10-25: summaries stay on the deployment's model

Will, 2026-10-25 03:55, a mid-turn "go" after the lead's recommendation of 2026-10-24 23:40 that timeline summaries stay
on the deployment's model even when a person has their own key. It came after an hour of network errors in that session,
and the lead read it as approval; the question stays open in [rulings §18](../rulings.md#18-open-questions-no-ruling-yet). A person's key pays only for their own chat and TODO runs. Summaries are the app's own
background work (the production proof spent about 28,000 tokens of the test account's key on 163 of them during
its runs), so the summary role never opens the person's model, at the endpoint or in a run: it resolves the deployment's
summary model, against the deployment's budget, as it did before this decision. The roles a person's model answers are
`OWN_MODEL_ROLES` (`agent`, `coding`, `renderer`, `judge`; `src/features/personal-model/contract.ts`).
