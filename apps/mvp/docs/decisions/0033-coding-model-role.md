# 0033: The coding model role

Status: implemented (2026-10-21). Ruling PROC-23 and its addendum (Will, 2026-10-21 20:50, queue item 940). Builds on [0016](0016-todos-and-the-stack.md) (the `todo` run) and the [model endpoint's roles](../features/model-endpoint.md#roles).

PROC-23 asked for the general ability to choose what backs the coding agent, so a deployment can point it at models it serves itself; our own use of the Claude Code and Codex subscriptions on the Mac mini is our configuration, not a product feature. The addendum set the bar: "there shouldn't be any buttons or anything that directly do claude or codex. Instead it should support the seams needed to do it yourself and it's at your own risk … do the bare minimum minimal cleanest seam you can that enables us to use claude and codex but do not actually make them claude or codex. Do not make our code buggy or complex with a bunch of complicated logic about rules for running peoples todos or stuff."

**Amended by [0132](0132-model-connections.md) (ruling AUTH-10, 2026-10-31):** decision 4 no longer holds. A person's
Claude or Codex subscription runs the vendor's own agent in their `todo` run's box, through one `sandbox/Command` job and
not through this decision's rejected `ExternalAgent` design. Decisions 1 to 3 stand for every other run.

## Decisions

1. **The seam is one model role, `coding`.** `todo/Implement`'s agent asks the model endpoint's `coding` role (`worker/Executions.ts`), the `agent` role keeps answering chat. An Admin sets it with `admin/SetModel { role: "coding", model }`, like every role. Until one does, `coding` answers with the `agent` role's model, its setting included, so a deployment that never sets it sees no change.
2. **Any endpoint, any key, pinned to its origin.** The record is a configured model: a protocol the product already speaks (Anthropic Messages, OpenAI Responses, OpenAI Chat Completions), a `baseUrl`, a `modelId` and a `credential` name. A deployment's own endpoint uses a key of its own naming, held by the Worker as `SMITHERS_MODEL_KEY_<NAME>` and pinned to that endpoint by `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`, so the key never travels anywhere else (`HostModel.make`). No product code changes for a new endpoint.
3. **Every model call stays a journaled step.** The Smithers agent loop runs as before; only its model changes. `ModelStep` seals each call, the endpoint admits and meters it under the deployment's budget, and its spend is booked to `coding`.
4. **No vendor in the product.** The product names no agent CLI, holds no subscription, routes nobody's work to anybody's account and has no rules about whose TODO runs where. Whatever serves a deployment's endpoint is that deployment's configuration and its own risk.
5. **Our own deployment builds no relay.** Our builders keep using the Claude Code and Codex CLIs directly, locally and outside the product, and our `coding` role points at a normal API endpoint: serving a subscription as a model endpoint is the shape Anthropic's terms bar, and it would put at risk the accounts our own builders depend on (lead, 2026-10-21).

## Rejected

- **An agent CLI as the coding agent** (the panel's merged design, 2026-10-21): an `ExternalAgent` step, a runner protocol, a job store, MCP tools for the CLI, adapters for Claude Code and Codex, and a runner command. Built and reviewed, then dropped by the addendum: vendor adapters and account routing are product code about specific vendors, and the CLI's own model calls would have been journaled per session, not per call. It stays in jj history.
- **Per-person routing and a journaling exception for the coding role** (queue item 940's two proposals): replaced by the addendum.

## Consequences

- One migration widens `model_roles.role` to admit `coding`.
- The `todo` run's spend is booked to `coding`, not `agent`, from this deploy on.
- A model call's sealed identity names its role, so a `todo` run parked mid-frame across the deploy asks its sealed call once more under `coding`, and pays for it again. Deploy it when no `todo:` run is parked, as for any change to the run (Codex Astra, 2026-10-21).
- A deployment that wants the CLIs' own agent loops, not just their models, has no seam for that in the product.

Verification: `worker/ModelEndpoint.test.ts` ("the coding role answers as the agent role does …": the default, following the agent role's setting, and its own origin-pinned key, with the agent role unchanged), `worker/SetModel.test.ts`, `db/Database.test.ts`.
