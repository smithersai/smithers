# Production history fixtures

2026-11-04. Lane e2e-fixtures; Will's production ship bar, TEST-1–TEST-7.

Tests resolve history and repository absence through real APIs at execution time.
Unset optional identifiers cannot silently remove production coverage. Failed
history is selected from the test account's visible runs and inspected for real
failure attempts. A repository run is selected there or created through the same
manual-run API the product uses. Creation requires the scratch repository's
existing public flow configuration; tests never widen that configuration.

The legacy undispatched-actions regression retains a verified execution because
new engine history does not reproduce that older recording shape. The identifier
lives outside the checkout in the private e2e settings. No test inserts or edits
journal records. A failed TODO can have a completed engine root after its failure
handler runs; tests distinguish the work's failure from that root's lifecycle.

An absent repository uses a unique name by default. Even an explicitly retained
name requires GitHub's current 404 followed by authenticated product About's 404.
Quota refusals and outages fail the test. Receipts contain identifiers and states,
never credentials or journal payloads. Configuration and usage are documented in
the infrastructure guide's deployment e2e settings.

The absent-repository journey checks recovery and that no clone action or import
exists. It no longer forces a clone of a name on which the person cannot hold a
repository role (AUTH-8). A metadata 404 denies work without distinguishing absence from an inaccessible
private repository; no clone authority is inferred from it.
The previous Not found/Retry journey assumed a launch despite that refusal and
could not serve as an absence fixture under the current admission policy.
