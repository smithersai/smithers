# 0164 — Production e2e owns resources per run

Date: 2026-11-04. Requested by Will in lane e2e-parallel. Implements TEST-1–7 and OBS-1–5.

Playwright's selected specs declare their shared resources in `e2e/resources.ts`, beside target needs. The production runner leases the union in a fixed global order. Repository mutation is exclusive. Model consumers share read leases; editors exclude readers and other editors. Run-owned conversations and branches need no mutation lock. Tests cannot silently enter production without a resource declaration.

Each run owns its output directory, private session snapshot, setup metadata and branch ref. Shared sign-in refresh alone is serialized. Setup cleans only the leased scratch repositories; it never resets unrelated repositories or a model connection while another run uses it. A bounded stack/factory pool can create test-account repositories only after reading and verifying the App's all-repositories installation. Unavailable provisioning falls back to configured scratch under the same repository resource lease. Full-pool contention waits.

Directory owner records contain PID, host, nonce and time. Unknown or dead owners are never taken over. Release validates ownership, and interruption retains leases until Playwright exits. A shared compatibility fence excludes older account-lock runners while allowing new runners to overlap. The fence creator remains alive until its participants leave; a crashed cohort fails closed.

This is test infrastructure, not a product feature or plugin. The library catalog's `@smthrs/integrations` GitHub client supplies authenticated provisioning and redacted provider errors. The existing Node/Playwright boundary supplies filesystem admission; no app background runtime is added. Real-filesystem and child-process tests cover admission; faulty Effect services exercise provider failure. Live concurrency and serialization receipts live in the lane's private status report. Pool provisioning needs an appropriately scoped real test-account credential; configured fallback remains available without one.
