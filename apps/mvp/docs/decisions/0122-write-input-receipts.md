# 0122: A write press survives before durable admission

Status: accepted implementation detail (2026-10-27). Extends [0002](0002-local-first.md); core transport infrastructure for the existing public flows, not a feature plugin.

A button or slash command synchronously stages its exact validated payload and command identity with the catalog's `@smthrs/platform-browser` `PendingSnapshot`, before UUID hashing or asynchronous persistence. The host fences the receipt by the current device owner and clears it on sign-out. Independent unfinished presses keep separate identities; pressing the same unchanged source again joins its retained identity. This temporary input receipt bridges admission; it does not send, retry or schedule work.

On opening the page, staged inputs enter their existing `@smthrs/effect-tanstack-db` outboxes once. Those libraries own durable storage, retry, resumption and idempotency. A receipt stays until admission and source cleanup succeed. Create additionally keeps an independent navigation acknowledgment until TanStack Router records the matching `?write=` identity; navigation alone cannot retire an unadmitted input. Recovery uses the exact original identity, waits for draft restoration and clears only its matching source draft, including the original conversation’s composer. Source cleanup failures retain their receipt. Edit and Discard use synchronous identity lookup and retire the matching input receipt before removing their visible recovery row; a running admission fences Discard.

`write.admission` records command identity, flow, stage, outcome and elapsed time. `write.identity` correlates command, execution and write identities. Recovery persistence, leader acquisition, outbox storage and engine admission each record pending and terminal receipts. Metrics omit identities. Payloads, hash inputs, repository names and credentials never enter these records.

Production reproduction on W14: immediate Create and TODO reloads reached hashing but no IndexedDB outbox transaction; their request identity was unavailable after reload. Prior unit tests awaited the action Promise before reloading, missing this interval. Regressions interrupt an unresolved device receipt and reload immediately after the actual browser press at 0, 100 and 300 ms.

## Recovery receipt precedence

Reload can restore a pre-admission `not_sent` row alongside the same write's durable outbox row: admission reached IndexedDB before removal of its earlier SQLite receipt persisted. The outbox receipt wins over that unrefused local row. An actual server refusal or failed server write still wins. The same rule applies to issues, comments, triage and TODOs; Retry appears only when there is no outgoing receipt or the write was genuinely refused.

A live admission receipt, like startup replay, clears only its exact submitted source snapshot. Typing into that draft while admission waits creates a newer source that the older receipt cannot delete. Faulted real queue services exercise this ordering for Create, Comment and TODO Commit.

Explicit Retry fences the original write throughout local persistence and admission, including older recovery rows without an input snapshot. Successful cleanup retires the input so a later identical press is a new write. Slash cleanup waits for the actual private composer transaction before retiring its identity. A TODO input refusal is visible as Not sent immediately; it persists the same recovery identity once when device persistence is usable and never starts delivery automatically.

Private composer drafts v2 retain an optional source generation. An actual edit changes that generation; restoration of an older row preserves its absent generation until edited. Admission joins only the same unchanged source, so clearing and retyping identical content creates an independent write. The migration leaves historical rows intact.

Live submission, startup recovery and page Retry share composer cleanup. `Collection.pendingWrites(key)` supplies actual unsettled receipts, including an optimistic deletion after navigation. Cleanup awaits those receipts and retains its input when a newer write or unsaved replacement still prevents confirmation. No application retry loop is added.
