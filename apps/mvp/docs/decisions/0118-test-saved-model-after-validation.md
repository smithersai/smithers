# 0118 — Validate model edits before testing the saved model

Date: 2026-10-26

Settings Test keeps the saved-model semantics of decisions 0096 and 0017. It first validates the visible form with
Save's `checkSave`; malformed input shows the same refusal. A valid edited configuration says **Save first**, and
starts no flow or provider call. A newly typed key always counts as an edit: its identity cannot be checked from the
four characters returned to the browser. An unchanged form runs the existing `model/test {}` durable flow.

This avoids putting plaintext draft keys into the durable browser engine, its journal or device storage. Save remains
the person-only request that seals keys before the server flow starts. The check stores only a refusal code and records
that code through the existing test telemetry. No draft URL, model id or key is recorded.
