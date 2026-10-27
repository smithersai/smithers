---
"@smthrs/effect-tanstack-db": minor
---

Expose live admission receipts and optional joining of an existing mutation/key while its write is live. Duplicate callers can await storage acceptance without treating optimistic rows as durable. Existing transact behavior stays available when joinExisting is omitted.
