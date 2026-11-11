---
title: Deployment prerequisites and rollback state
status: done
area: infrastructure
owner: codex-deployment
updated: 2026-11-11
links: [../infrastructure.md]
---

Derive the deploy install from workspace dependencies and build inputs, verify prerequisites before publication, and reconcile Worker state against live versions after rollback. Use Effect services and the existing Alchemy state store; retain resource ownership and secret identities.

Completed: the deployment install includes workspace bundle inputs and root build tools; the preflight runs before packing or publication; Worker state verifies its cached content against the live version and the provider's publication receipt. Rollback, missing Workers and older state invalidate cached hashes while preserving resource identity.

Validation: all 26 deployment regressions pass, including 100 generated dependency graphs and seeded publication/rollback histories. Restoring the manifest-only install, unprotected deploy and stock state cache each makes its regression fail; restoring the fixes makes the suite pass. The clean frozen install, dependency verification, CLI-pack import, Astro executable check and all four MVP typecheck projects pass. No production deployment was performed.
