# Vibing and appending to main

Finalization admission is implemented as the private `coding/AdmitVibe` flow.
The public `coding/vibe` descriptor, complete cleanup/publication/append
composition and shipment are still being integrated. The existing request
outcome stops at validated, changes-requested or blocked.

## Reuse the recorded request

`VibeInput` accepts only `{ requestExecutionId }`. `ReadVibeRequest` reads the
completed native Request through the existing RunStore, checks its successful
domain outcome, and walks at most 1,024 retained executions to one completed
approved control wrapper in this host. The persisted `coding/request` registry
bridge must carry the same decoded input as both Request and the approved
control plan. The approved envelope names `coding/RunRequest`; the registry
inlines that delegate, so a separate RunRequest row is not required. Ordinary
spawn edges and trampoline row parents use their existing meanings. A native
control fork remains eligible when it satisfies the same wrapper checks.

The current finalization owner is read from the per-handler ModuleOwner service;
an absent owner refuses. Layer construction never installs a dummy authority.
`VerifyVibe` reuses ValidatePlan, FastGate and Assess rather than adding a weaker
policy. It rejects duplicate check IDs before those gates, then snapshots and
checks the native source, retaining a fresh operation fence for the first
mutation. Missing, collected, conflicting or ambiguous evidence refuses.

These are new private action values in `vibe-schema.ts`: `VibeEvidence` stores
existing request/control/approval/POC identities, original source and the
RequestResult; `VibeAdmission` adds the current validated head. There is no new
database or public package service. Lookup is bounded to 16 MiB per retained
state and 32 MiB of decoded state in total, checked after RunStore reads; it
does not scan the global catalog. The unique POC lookup is a filtered two-row
page from the existing RunCatalogRead. Admission is not cleanup or landing.

The immutable source base is the source captured before this entire request,
including before any implementation which later steering revised. The final
Plan's observedHead can already contain an earlier implementation. It is not
sufficient proof of the request's starting tree. Read the unique completed Poc
child directly under the Request using the existing RunCatalogRead/RunStore,
require that its result source equals its input source, and retain that exact
immutable commit. This uses the already retained source receipt without adding
a second provenance ledger or duplicating the POC in RequestResult.

## Clean the existing native history

Use an evidence-only review of the validated native atom sequence and existing
plans to propose final descriptions and context. Native JJ remains the identity
owner. Apply approved description/organization changes through the existing
fenced operations and record their native receipts. A rewrite invalidates the
receipts that depend on changed commits or parents; rerun their real checks
through the existing graph before accepting the final history. The final source
tree must retain the validated implementation behavior. Cleanup is not a reason
to silently replace the original source base with a newer main.

Portable prompt, plan and implementation context in history still needs its
Plue-owned notes/provenance integration. Current local operation receipts report
cloud provenance as pending; finalization must not turn that into an
acknowledged publication merely because an operation returned successfully.

## One appended commit through existing landing policy

The new Plue public operation, landed at `fb56b0b53a08`, is:

```http
PUT /api/repos/{owner}/{repo}/landings/{number}/land/append
Content-Type: application/json

{
  "commit_id": "<immutable final mythical tip>",
  "expected_commit_id": "<fenced main commit>",
  "source_base_commit_id": "<immutable source before this request>",
  "description": "✨ feat: describe the validated product change"
}
```

This is a new public API. The existing LandingService authenticates and pins the
request, returning the existing 202 queued response. Its existing worker checks
every ownership, human/agent review and required status gate before mutation;
acceptance does not claim those gates passed. This keeps full-history inspection
inside the worker's existing budget. The matching native append creates exactly one commit whose sole
parent is expected main and whose tree equals the immutable source tip. Before
that write, the original source-base tree must equal the fenced main tree.
A mismatch requires reconciliation; it must not overwrite newer main changes.
The mythical source commits retain their native identities.

The landing stack must cover the entire request, including changes implemented
before later steering. Compare the original source-base and final source's
single-parent native histories to find their shared immutable prefix. Require
the landing's ordered change IDs to equal the complete current suffix after
that prefix, including every rewritten descendant. Checking only the latest
plan or final tip would omit earlier changes from existing review policy.
The previous source anchor must come from an authentic native append receipt
bound to expected main; caller-supplied source trees cannot erase earlier
owners. Without that mapping, the first independent history import includes
every source commit. Merge histories, incomplete suffixes, duplicate native
identities and ambiguous identity are refusals. Existing landing admission is
bounded to 1,024 changes; exceeding it refuses without truncation or mutation.

Older Go/Rust decoders ignore unknown fields. Therefore the public append route,
internal `/land/append` route and `smithers_land_append` ABI marker are distinct
from ordinary landing; none may fall back to the ordinary route. A specifically
typed missing-receipt response distinguishes a first attempt from a missing old
server route. Lost acknowledgements replay the exact existing operation receipt,
including after main has subsequently moved.

The existing landing task now has immutable `append_request` metadata and an
`append_pending` state. This is an addition to existing internal task data/state,
not a new queue or table. Its database constraint and claim/reaper rules
prevent older workers from treating an append task as ordinary landing. Deploy
the migration, new worker and repo-host together before enabling the route. Existing
ordinary task behavior and old native receipt serialization remain compatible.

The existing reserved repository API credentials are
`SMITHERS_JJHUB_TOKEN` and `SMITHERS_JJHUB_API_URL`. The separate
`SMITHERS_AGENT_TOKEN` is the agent callback credential and must not be used for
repository API writes. Reuse the established scoped route/client; do not put
credentials in workflow payloads, notes or model context.

## Separate product states

A validated request can begin vibing: final history and context cleanup, repeated
checks required by rewrites, then append according to the existing landing
policy. An accepted landing task is pending work, not proof that main changed.
Poll the existing landing state and verify its native result before calling it
landed. Optional delivery checks and canary workflows use the existing required
check receipts; only actual successful delivery evidence can mark work shipped.
The UI should expose each of these through the existing recursive cards and
source-qualified flow actions, not infer them from a green parent run.

Wiki freshness is part of source backpressure as well as final publication.
The required slow Wiki check must inspect the exact immutable implementation
export and return a normal Receipt/finding to the existing correction loop.
Running a live-root wiki while optimistic editing continues would race the
source identity. Publishing a verified final wiki requires a source fence and
must not publish a disposable check workspace as the repository's current wiki.
