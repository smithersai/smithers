---
"@smthrs/agent": patch
---

Expose optional per-provider-call budget reservations and durable accounting receipts, including in-step reissues. Seal the answer before reconciling receipts so a ledger failure replays accounting without another provider call. Count failed calls with no reported usage even after earlier known spend, and mark reissued aggregate usage incomplete.
