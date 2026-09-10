# Admission and native history cleanup

Finalization begins with the completed request's retained evidence. The private `coding/AdmitVibe` and `coding/CleanVibeHistory` flows reuse existing native stores, authority and check gates. Their receipts distinguish permission to start cleanup from completed cleanup. Neither receipt asserts landing or shipment.

## Read the approved request

`VibeInput` contains only `requestExecutionId`. Admission requires the per-handler owner of an approved `coding/vibe` execution. It reads a successful native `coding/Request`, its matching descriptor bridge and one completed approved control wrapper. Missing, ambiguous, cancelled or collected ancestry refuses. Lookup walks at most 1,024 executions and bounds decoded state; it does not scan the global run catalog.

The original source comes from exactly one completed POC directly owned by that Request. Its retained result must match its captured input. Later steering can move a plan's starting point, so the final plan alone cannot identify the source before the whole request. `VibeEvidence` retains that original source, request result and existing request, control, approval and POC identities.

## Reuse current validation policy

Admission checks the retained result through the existing ValidatePlan, FastGate and Assess actions. Duplicate check IDs, an unsuccessful domain outcome or a stale source refuse. A fresh native snapshot and read must still match the validated final revision. The resulting `VibeAdmission` adds a current operation fence for the first cleanup mutation.

## Describe the same native atoms

The evidence-only ReviewHistory action uses the configured implementation role to propose a summary and descriptions for the same ordered atoms, up to 128. Each subject must follow the emoji conventional-commit form. This proposal cannot add, remove or reorder atoms or edit source.

Each description rewrite records an exact operation fence and a flow-derived request identity. The existing ApplyNative action receives that recorded payload; confirmation requires the requested description and unchanged source tree. RefreshHistory reads native atoms in batches of at most 100 under one observed head and operation, preserving every atom's tree, native change ID and linear parent relationship.

## Recheck before continuing

Cleanup invokes the actual declared fast and slow checks through RunCheck, FastGate and Assess. Even already-clean descriptions are revalidated. Failed checks refuse finalization while leaving completed native rewrites and receipts inspectable. A final source fence must still match the admission tree.

`VibeCleanup` contains the admission, summary, refreshed result and native head. These are private Effect schemas for ordinary flow values. The subsequent source publication, complete `coding/vibe` composition, append and delivery stages remain separate responsibilities; this cleanup receipt cannot stand in for their evidence.

## Inspect the recorded stage

The request card's Vibe invitation requires a completed validated Request, matching plan and coherent recorded bridge ancestry. It also requires the latest unambiguous catalog for that card's repository and workspace to advertise `coding/vibe`. Without that advertised capability, the card offers to check available flows. The server still validates authority and source when invoked.

The recursive card derives `CodingVibeProgress` from completed admission or cleanup child receipts with matching request identity and owned ancestry. Its compact text distinguishes admission from cleaned descriptions and revalidated checks. The Inspect button selects that exact native child in the existing debugger; a completed parent alone supplies neither stage.
