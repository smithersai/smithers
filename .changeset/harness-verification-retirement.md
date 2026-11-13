---
"@smthrs/harness": minor
---

Remove the unused `VacuousVerification` namespace and `@smthrs/harness/VacuousVerification` subpath. Stored `vacuous-verification-observed` events remain readable. The `discipline-armed` event now records the per-call ceiling enforced by the controller even when the sandbox supplies no call limits.
