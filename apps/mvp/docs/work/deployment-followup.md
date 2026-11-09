---
title: Deployment smoke and release contract follow-up
status: in-progress
area: app
owner: codex
updated: 2026-11-09
links: [../infrastructure.md]
---

Reproduce the first-paint beacon error, release packing contracts, private adapter contracts, and persisted device upgrade tests. Compare the previous deployment with the current deployment, retain regression coverage, and validate fixes through real dependencies. Infrastructure changes use Alchemy; browser smoke continues to fail on console errors.

Library catalog: existing Alchemy Cloudflare resources for infrastructure, Effect for declaration composition, and `@smthrs/effect-tanstack-db` for persisted-device migration behavior. No new library is introduced.

The release roster, CommonJS declaration scan, release workflow parity, and private adapter declarations are fixed. Fresh validation passes all 53 release tests, 10 adapter tests with real socket traffic and typed consumers, 34 workflow rehearsal tests, and 13 infrastructure/domain tests. The app typecheck and target-index checks pass. The analytics regression fails with automatic injection enabled and passes when it is disabled.

The remaining production change declares the existing Web Analytics site through Alchemy with automatic injection disabled. The first-paint suite still rejects console errors and now explicitly checks for a returning injected beacon after attaching its diagnostics. Deployment and live smoke remain to be recorded; the previous release's four persisted-device upgrade cases pass, and newer-revision database comparisons remain in progress.
