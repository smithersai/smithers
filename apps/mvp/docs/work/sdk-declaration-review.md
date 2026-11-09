---
title: Reviewed SDK declarations after the dependency upgrade
status: done
area: release
owner: codex
updated: 2026-11-09
links: []
---

Reproduce the declaration gate on untouched main, compare every changed
declaration with the last reviewed baseline, and attribute changes to their
source revisions. Record dependency upgrade costs separately from subsequent
intentional APIs. Refresh only reviewed declarations with the owning generator;
retain the declaration gate unchanged.

Validate and publish the existing browser telemetry and TLS policy corrections
after the baseline repair. Deployment is handled separately.

The original gate fails on unchanged main for 43 of 52 packages. Every historic
hash reproduces. Decision 0166 records all 565 changed declaration files and
their provenance. The unintended readonly options regression is restored and
tested separately; the final baseline passes the unchanged checker. The errors
package passes 66 tests with 100% coverage, and strict consumer and API-docs
checks pass. The app corrections pass all 137 focused tests and all four app typecheck
projects. Playwright lists 15 affected tests. Publication follows independent
review and the repository landing checks; deployment is separate.

The later accepted VIP-44 canonical collection sorter adds one more reviewed
package, two declaration files and a publication subpath. The subsequent
deferred-completion correction adds the documented `NotFound` outcome to the
existing engine-store entry. The final refresh covers 44 packages; the original
43-package audit remains a separate historical comparison in decision 0166.

The later VIP-44 shared `payloadSnapshot` and `payloadPreimage` APIs, their
Flow re-export and the Cloudflare declaration documentation are also recorded.
That intermediate historical comparison is 44 packages and 569 declaration files.


The final record covers all later accepted VIP-44 serialization and durable
skills-payload declarations: 44 packages and 573 files against the old snapshot.
A separate source repair restores the result and decoder-service types lost
by serializer-aware dispatch. Exact-source before checks fail, repaired SDK
checks and 22 focused tests pass, and a 50-case property covers cache pairs
under four JSON serializers. The runtime AST is unchanged by that type repair.
