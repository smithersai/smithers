# 0027. Proposal and specification acceptance

**Status:** implemented locally, 2026-11-08. **Rulings:** VL-9 to VL-15, VL-23, VL-30, VL-32; PROC-28, FLOW-3.

## Two gates in one machine

`conversation.vibe` owns both rules. `approveVip` is the only VIP acceptance transition. It requires an in-review
VIP, a maintainer role, a person principal, and nonempty approver and timestamp. It preserves issue identity,
content, task and open/closed state. An agent with a maintainer role is still refused. Declining cannot accept.
The UI displays the required person/role, state, approver and timestamp. A GitHub accepted label by itself cannot
supply a human approval: the project object's gate receipt must also exist. GitHub remains authoritative for the
proposal document, issue and review change; gate receipts neither merge that change nor commit a task.

A specification has immutable numbered revisions and four named slots: Codex Astra, Codex Sol, Claude Fable and
Claude Opus. Each slot records verdict, grade, reviewed revision and review link. Acceptance is derived, never a
writable flag: all four must be LGTM/A on the current positive revision with a review receipt. Changing the text
increments the revision and clears every field of every answer; saving identical text changes nothing. A stale
review result cannot be recorded. The history retains review results and resets; the review links target those
receipts, including the review text. The specification is editable by maintainers; contributors can request reviews.
Both use 0019's single policy mapping.

## Shared flows and authority

`vibelang/issues/spec-revise` and `vibelang/issues/spec-review` extend 0022's real flows. Factory, the browser and
the shared CLI/MCP `issue` command use them. A request chooses a reviewer and the expected revision, never an
answer, grade, model, principal or review URL. Only the host's `SpecificationReviewers` service supplies the result.
The host binds it to the requested seat and current immutable revision. A person can request a review, but cannot
record one on behalf of the reviewer. Forged extra answer fields are discarded by the flow codec.

The live service calls Smithers' `AgentAction`, whose model calls are `ModelStep`s. Deployment Config must bind
`SPEC_REVIEW_ASTRA`, `SPEC_REVIEW_SOL`, `SPEC_REVIEW_FABLE`, and `SPEC_REVIEW_OPUS` to the corresponding named
models. All four records and credential references are read during Alchemy synthesis and object startup, so they are bound before a request. Each value has the existing `CHAT_MODEL` record shape (`protocol`, `modelId`, `credential`, optional
`baseUrl`, `path`, `extraBody`). There is no fallback to the chat model. Missing or unusable configuration refuses
the review. The existing shared daily budget admits and journals spend, including a failed review's paid usage.
No real provider credential was used for this lane's tests; workerd exercises the host-injected scripted service.

The project Accounts object serializes gate operations and stores gate state and receipts beside the native SQLite
flow journal. Its authenticated authority is resolved before a cached flow receipt can return. CLI/MCP and chat
have no Accept/Decline tool; their input codec rejects either operation. The live HTTP boundary additionally refuses
an agent principal, even at Maintainer and even on replay of a person's successful operation.
The inherited live-chat issue delegation remains held for `issues-nested-effect` as documented in 0022; this change
does not alter VibeLang compilation or introduce another route around it.

## UI and product mock mode

Specification sits beside VIPs in the Issues header and reuses `wiki/designs/issues/`'s Smithers cards, table, badges
and narrow form. Four rows show reviewer, verdict, grade and revision; review links open retained receipts. After
acceptance, Self-consistency links Fuzz, Coverage and Proofs to the app's existing suite records. Their current
in-progress states are generated from those records at build time; the gate never claims the broader 100% target
has passed. No new explanatory product prose is added.

The fixture starts at revision 2, accepted by all four, reflecting PROC-28. Its synthetic history retains revision
1's changes-requested/B answer, revision 2's reset and four A answers. Fixture timestamps and seeded review links are
fixture data, not claimed historical provider receipts. A new revision clears all answers. The scripted Opus first
returns LGTM/B, then LGTM/A on another request. The other scripted reviewers return LGTM/A. This makes the three-A,
one-B refusal and subsequent acceptance usable with no backend, sign-in or model. The maintainer fixture identity
approves VIPs through the same flow as live. Review scripts cannot approve a VIP.

## Proof and behavioral evidence

Contracts prove the human gate, exact single-review predicate, conjunction of all four reviewers, revision reset,
reviewer authority and stale-result rejection, preserving unrelated seats and specification text/revision.
Twenty-four executable mutations remove each authority/review guard, each required seat, each seat's reset and both
new least-role mappings. Contracts stay byte-identical and rejection must be a Dafny obligation, never a compiler
or tool failure. Existing VIP projection mutations now target the guarded acceptance and decline transitions.

Tests cover the pure machine, real memory flows, faulty reviewer services, CLI/MCP's shared command, Foldkit scenes,
the live HTTP handler on workerd's SQLite engine, and Chromium at desktop and phone widths. The whole-feature
Mock walkthrough includes both gates. The gate fuzz target generates verdict, grade, revision and receipt combinations
for all four reviewers and human/agent approval combinations. The benchmark retains all sixteen single-review
refusals and both principal kinds. The lane report records executed counts, command exits and screenshots.

Catalog entries reused: `@smthrs/flow`, `@smthrs/engine`, `@smthrs/agent`, `@smthrs/model-host`,
`@smthrs/platform-cloudflare`, `@smthrs/ui-css`, `@smthrs/fuzz` and `@smthrs/testing`. No dependency is added.

The phone table has a geometry regression test: all four review actions must remain inside the viewport. A failing
phone run caught the original clipped action column; compact cell spacing, a short visible Review label and Rev
heading retain the complete four-seat table without horizontal clipping. The accessible action remains Request review.

## Revisions after acceptance (2026-11-08)

Whether a new revision of an accepted specification needs all four reviews again is not Will's rule yet: VL-32 quotes
him that the specification is accepted once and then "needs to be self consistent and optimistically built fuzz
tested". The question is open for him at lang.smithers.sh/factory/open (question 3). Until he answers, one constant,
`SPEC_REVISION_POLICY` in `src/core/conversation.vibe`, holds the behavior: `"reset"` (today) clears the four answers on
each new revision; `"keep"` keeps the acceptance the four gave one revision. Both are proved
(`reviseSpecificationUnder`, `specificationAcceptedUnder`). The live reviewer models stay unbound: Mock shows the gate,
and real specification reviews run in the new factory (smithersai/lang).
