---
"@smthrs/control": minor
"@smthrs/engine-store": patch
---

**Breaking:** `ControlRuntime.Service` drops `deliverSignal`, `installBulkGrant` and `grants`, and the package drops the
`BulkGrant` type. Signals reach a run through `Control.signal` and the signal inbox; legacy `control_run_messages` rows
stay readable through `deliveredSignals`. An approval's scope lives on its token's decision and in the journaled
`control.approval.approved` fact; migration `0009_drop_grants` drops the `control_grants` table nothing read, and
`Retention` no longer lists it.

**Breaking:** `CredentialStore.Service` and `Credential` operations can fail with `PersistenceError`.
`SqlCredentialStore` reports a database failure as `PersistenceError` on operation `credential.<op>` with the driver's
failure as `cause`, where it reported `Unavailable` and dropped the cause; `migrate`, `make` and `layer` fail with
`PersistenceError`. `remove` runs through the durable writer like `write`.

A run that settles while a resume delegation stands no longer reports `pendingResume` on `getRun` or a listing.
