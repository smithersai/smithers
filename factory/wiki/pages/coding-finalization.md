# Admission and native history cleanup

The public `coding/vibe` descriptor's module is the `coding/Vibe` flow. It runs three private children in order: `coding/AdmitVibe`, `coding/CleanVibeHistory` and `coding/LandVibe`. This page covers the first two. Each child leaves its own receipt, and admission is not cleanup or landing.

## Read the approved request

`VibeInput` accepts only `{ requestExecutionId }`. `ReadVibeRequest` reads the completed native Request, checks its successful domain outcome, and walks at most 1,024 retained executions to one completed approved control wrapper. Lookup is bounded to 16 MiB per retained state and 32 MiB of decoded state in total; it does not scan the global catalog.

The finalization owner comes from the per-handler ModuleOwner service; an absent owner refuses. The host registers `coding/vibe` only when the prompt route's project configuration and a landing binding are both present.

## Fix the original source

The immutable source base is the source captured before the whole request. The final Plan's observed head is not sufficient proof of it, because later steering can revise earlier implementation. Admission reads the unique completed `PrepareRequest` child under the Request and retains its observed source. Legacy executions without a preparation child still require the unique Poc child with matching input and result source.

Before any snapshot, admission calls the `coding/PublishVibeSource` child with the original source. Its retained cloud acknowledgment must succeed; a local-only host or missing publication capability refuses.

## Reuse current validation policy

`VerifyVibe` reuses ValidatePlan, FastGate and Assess rather than a weaker policy. It rejects duplicate check IDs, then snapshots the native source and retains a fresh operation fence for the first mutation. `VibeEvidence` stores the existing identities, original source and RequestResult; `VibeAdmission` adds the current validated head.

## Describe the same native atoms

`CleanVibeHistory` uses an evidence-only ReviewHistory action through the `coding/implement` model role. It proposes one summary and a description for each validated atom, in order, up to 128. Every subject must be an emoji conventional commit. The model cannot insert, remove or reorder atoms or edit source.

For each atom, PrepareDescription captures the exact native operation fence and request ID. ApplyNative executes that recorded payload, and a lost acknowledgment retries the identical payload. ConfirmDescription checks the requested text and the preserved source tree.

## Recheck before landing

RefreshHistory reads native atoms in batches of at most 100 under one observed head and operation, verifying every atom tree and linear parent relationship. RecheckFinalHistory runs the required fast and slow checks through RunCheck, FastGate and Assess, even when every description was already clean. Failed checks refuse finalization while keeping the completed rewrites and receipts; there is no rollback.

The private `VibeCleanup` receipt contains the admission, summary, refreshed Result and native head. It proves description cleanup and revalidation only. `LandVibe` then retains the cleaned source and continues through the existing landing policy.
