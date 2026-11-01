# 0146: Draft writes and save receipts

Status: accepted
Date: 2026-10-21, landed 2026-11-01 (stranded work from the worker-concurrency review, renumbered from its draft 0038).

A draft save locks the draft before checking its source, checks, questions and ownership, and holds the lock through the revision insert and the receipt write, so two saves of one draft return one receipt, including when the save creates a new flow. Answer submissions take the same lock before checking the round and merging answers.

A round may move from drafting to its result once. A late same-round write can't overwrite a round that has its result, or the answers given to it; another drafting pass uses a newer round.

`flow_drafts.saved_revision` records the saved revision. A repeated save returns the draft's saved name and revision even after later edits or deletion of the flow. Migration 0087 recovers historical receipts only when exactly one revision shares the draft's save transaction timestamp. An unknown receipt answers `503 unavailable` with the save route's `receipt_missing` log code, rather than claiming a current revision.

Repository admission fails with `RepoAdmissionLost` when its fenced update finds no `cloning` row owned by the attempt. The clone flow maps ownership loss to a non-retryable `CloneRefused`: it makes no import call, records the failed outcome, and fences settlement.

Libraries: Effect SQL transactions; the existing Code Storage and immutable-cache APIs are unchanged. No new dependency or runtime.
