# Vibing and appending to main

The public `coding/vibe` descriptor delegates to `coding/RunVibe`, whose
`coding/Vibe` flow composes three private children in order: `coding/AdmitVibe`,
`coding/CleanVibeHistory` and `coding/LandVibe`. Each child leaves its own
source-qualified receipt for the existing cards. Shipment is separate and not
implemented. The existing request outcome stops at validated, changes-requested
or blocked.

The host registers `coding/vibe` only when both the prompt route's project
configuration and a landing binding are present; it then advertises the
`coding-vibe/v1` capability. Without a binding the workspace stays local-only
and the descriptor is absent from the catalog.

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
Before any snapshot, AdmitVibe calls the ordinary `coding/PublishVibeSource`
child with the original source. Its retained cloud acknowledgment must succeed;
an explicit local-only host or a missing/old publication capability refuses.
An original source already retained remotely remains eligible after later local
rewrites. An unretained source that already moved cannot be replaced with a newer
one. Only after that receipt does admission enter VerifyVibe.

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

The same publication child accepts the cleaned source after final checks. Its
private `PublicationInput` is `{ source: Revision, phase: "original" | "cleaned" }`.
It delegates to NativeCoding.publishOriginalSource with a stable per-execution
request ID and returns the existing SourcePublication receipt. The existing guest
helper owns authorization, exact-source checks, native transport and ACK recovery.
No credential is part of either value. Native receipt schemas now live in the
pure `native-schema.ts` module so the browser can decode the same contracts;
`native.ts` re-exports its existing names and retains the Effect/process adapter.

The immutable source base is the source captured before this entire request,
including before any implementation which later steering revised. The final
Plan's observedHead can already contain an earlier implementation. It is not
sufficient proof of the request's starting tree. Read the unique completed Poc
child directly under the Request using the existing RunCatalogRead/RunStore,
require that its result source equals its input source, and retain that exact
immutable commit. This uses the already retained source receipt without adding
a second provenance ledger or duplicating the POC in RequestResult.

## Clean the existing native history

`CleanVibeHistory` uses an evidence-only ReviewHistory action through the existing
`coding/implement` model role. Its private proposal contains one final summary
and `{ changeId, description }` for each of the request's validated atoms, in
order, up to 128. Every description and the summary require an emoji conventional
commit subject. The model cannot insert, remove or reorder atoms or edit source.

For each atom, PrepareDescription captures the exact native operation fence and
the existing flow-derived request ID. ApplyNative executes that recorded payload;
a lost acknowledgment retries the identical payload to recover the native JJ
receipt. ConfirmDescription checks the requested text and preserved source tree.
JJ adds a terminal newline, so confirmation uses the adapter's existing trailing
newline comparison. Neither rewritten commit IDs nor unchanged descriptions
produce replacement atomic identities.

RefreshHistory reads the native atoms in batches of at most 100 under one observed
head/operation, verifies every original atom tree and linear parent relationship,
and reconstructs the existing Implementation values. RecheckFinalHistory runs the
actual required fast and slow checks through RunCheck, FastGate and Assess. It
rechecks the full request even when all descriptions were already clean. A final
source fence must still equal the validated implementation tree. Failed checks
refuse finalization while retaining the completed rewrites and action receipts;
there is no rollback or claim of append success.

The private `VibeCleanup` receipt contains its admission, summary, refreshed Result
and native head. It proves description cleanup and revalidation only. Admission
already required original-source retention before any rewrite; `LandVibe`
retains the cleaned source next and continues through Plue's existing landing
policy. Cleanup never substitutes a newer main for the original source base.

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
`SMITHERS_JJHUB_TOKEN` and `SMITHERS_JJHUB_API_URL`. `landing-config.ts` reads
them once at the executable boundary, together with the provisioned
`/etc/smithers/workspace-coding.json` binding (repository slug, ID, workspace ID
and this exact repository path), and deletes the token from `process.env` before
the host, model seats or any approved shell tool start. The token is an Effect
`Redacted` value inside the `coding/Landing` adapter only. The separate
`SMITHERS_AGENT_TOKEN` is the agent callback credential and must not be used for
repository API writes. Reuse the established scoped route/client; do not put
credentials in workflow payloads, notes or model context.

## Append through the landing adapter

`landing.ts` is an opinionated Effect adapter over the existing repository API,
constructed over the host's selected Node or Bun HttpClient with redirects
refused, a 90 second deadline, a 2 MiB bounded response body and no remote body
or credential in any error. `LandVibe` runs, in this order and only after the
cleaned-source retention receipt:

1. `PrepareAppend` reads the one unambiguous local `main` bookmark through the
   existing paginated bookmark route, then asks the native
   `landings/append/prepare` route for the ordered suffix between the immutable
   original source and the cleaned tip. This request's validated atoms must be
   that suffix's ordered tail; anything else refuses before creation.
2. `CreateLanding` PUTs the landing under the flow-derived request ID so a lost
   acknowledgement replays the identical immutable body. The title is the
   summary's first line; the body is the cleanup summary.
3. `QueueAppend` PUTs `landings/{number}/land/append` and records the 202
   task ID, preparation and exact request.
4. `AwaitVibeAppend` is a `Poll` of up to 90 durable 10 second rounds over the
   append observation route. Every observation must match the queued task,
   stack, source, base and description. A transport failure is an unsatisfied
   round, never a re-queue. A process restart resumes the wait.
5. `VerifyLanded` accepts only a `landed` observation whose landed count equals
   the prepared stack and whose retained cleaned source is the appended tip.
   `failed` is a typed policy refusal naming the landing; `pending` after the
   last round is `unavailable`: pending work, not a changed main.

The `VibeLanded` receipt carries the cleanup, the cleaned-source retention, the
landing identity, task ID, appended main commit and landed count.

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
