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
writable flag: all four must be LGTM with A+, A or A- on the same positive revision with a review receipt. Changing the text
increments the revision and keeps all four answers and their acceptance under the project's `"keep"` policy; saving identical text changes nothing. A stale
review result cannot be recorded. The history retains review results, new revisions and earlier resets; the review links target those
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

The fixture starts at revision 2, accepted with Astra A, Sol A, Fable A-, Opus A-, reflecting panel `v6`
(2026-10-29 UTC). All four `~/vibe/review-spec/v6/<reviewer>/REPORT.md` records on nyc-01 confirm these grades.
Smithers main `c27bfe7f` corrects the earlier citation: October 28's `r6` did not pass (Opus B+); `v6` did.
Its synthetic history retains revision 1's changes-requested/B answer, revision 2's pre-keep reset, and these four
answers. Fixture timestamps and seeded review links are fixture data, not historical provider receipts. A new
revision keeps all answers and records a Revision event. Scripted reviews use the same A, A, A-, A- grades; only
an unreviewed Opus seat first returns LGTM/B+, then LGTM/A-. An explicit new panel must still agree on one revision.
The maintainer fixture identity
approves VIPs through the same flow as live. Review scripts cannot approve a VIP.

## Proof and behavioral evidence

Contracts prove the human gate, exact A- or better single-review predicate, conjunction of all four reviewers, both revision policies,
reviewer authority and stale-result rejection, preserving unrelated seats and specification text/revision.
Twenty-nine executable mutations change each authority/review guard or grade boundary, each required seat, each seat's reset and both
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

## VL-32 addenda (2026-11-09, lane vl-gates2)

Will, 2026-11-09 04:25 PST: **"Yes a- counts"** (PROC-28 addendum on Smithers main, commit `080d48c6`).
Gate 2 accepts exactly A+, A and A-, with all four reviewers answering LGTM on the same revision. B+ refuses.
The live model-result codec admits plus/minus grades, and its instruction names the same acceptance boundary;
wire state and history preserve the exact grade string. UI, CLI, MCP and chat show that grade without rounding.

The lang lead decided under Will's delegation at `lang.smithers.sh/factory/open`, question 3:
**"after acceptance, a specification change does not reset the four reviewers; automated checks keep it
self-consistent, and a full panel runs again for a release."** `SPEC_REVISION_POLICY` is now `"keep"`.
The earlier open question and provisional reset default are superseded. Both explicit policies remain proved by
`reviseSpecificationUnder` and `specificationAcceptedUnder`; reset-specific cases name `"reset"` directly.
Keeping acceptance preserves the reviewed revision and all receipt fields; it never relabels an old review as current.
An explicitly requested new panel still needs all four seats on one revision; stale results are still refused.

Regressions cover A- and A+ in every seat, three A and one A-, refusal of B+/lower/unknown grades, a changed accepted
specification retaining acceptance, the exact fixture grades and retained receipts, and Revision history without a
new Reset. Memory flows, scenes, emitted CLI/MCP, workerd, fuzzing, benchmarks and Chromium use the keep policy.
Executable grade mutations separately accept B+, accept any grade, reject A-, and reject A+; every existing gate
guard and both policies retain negative controls. Existing issue flows supply logs, spans and counters; this adds
no step or dependency. Lead deploys.

The expanded whole-conversation proof hit the prior 1,200-second process wall on the shared host. Its bounded
process allowance is 3,600 seconds; every original assertion is still checked with eight workers and the same
60-second solver limit per assertion batch. Negative-case limits remain 30 seconds and timeouts still fail.
The gate's 29 mutations all reached actual failed Dafny obligations before this wall-budget adjustment.
Live reviewer models remain unbound; real specification panels run in the new factory (`smithersai/lang`).

## Retained acceptance receipts

The specification stores its first complete passing panel separately from each seat's latest answer. The `keep`
gate validates that immutable panel's four grades, verdicts, revision and links. An edit or any individual re-review
cannot revoke it; the latest answers still determine whether the current revision passes the `reset` gate.
Older snapshots without this optional receipt remain readable and capture their passing panel before an edit or
review replaces it. An explicit `reset` revision clears both the answers and the retained panel.

Regressions: `test/gates.test.vibe`, including shared-flow reviews and a schema round trip.
Property: `fuzz/gates.fuzz.vibe`, `gates/retained-panel-through-reviews`.
