---
"@smthrs/triggers": minor
---

A trigger that never fired no longer loses its first boundary to a restart across it. `Registered.registeredAt`, the store clock at the id's first registration and kept across re-registration, is the durable catch-up baseline until `lastFiredAt` exists; the `0005_registered_at` migration adds it. Under `buffer-one`, an occurrence a newer one replaces is now recorded `skipped` instead of staying `buffered` forever, and `pruneFires` removes `buffered` and unsettled rows that nothing holds.
