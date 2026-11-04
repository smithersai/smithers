---
title: Require repository authority in display stores
status: done
area: repository-access
owner: codex-repostore
updated: 2026-11-04
links: [../decisions/0110-shape-authority.md]
---

Require RepoStore in Plugins, HomeStore, FilesStore, DomainsStore, SecretsStore, FleetStore and RunsStore. Test their Effect layer requirements before removing raw collection fallbacks; provide real authority in isolated test compositions. Validate affected features, the data gate and repository tests and all four typecheck projects against main on cfbox's pg image through nyc-01. One reviewed commit; no land or push.

Library catalog: existing `@smthrs/effect-tanstack-db` live queries and `@smthrs/effect-electric` shapes. This fixes core authorization infrastructure under decision 0110.

Validation: the tests-first run failed all seven authority requirements against the original stores. On cfbox's pg image through nyc-01, the affected features, repository and both data-gate suites passed 687 tests in 58 files; updated main (`ab147d6824cf`) passed 679 in 57. Home and both data-gate suites passed another 87 tests after a query typing correction; the final correction retained the existing erased query casts, and all four typecheck projects passed. No new failing test names or typecheck diagnostics remain. Both scoped runs still fail the same whole-app coverage thresholds (lines, functions, statements and branches); thresholds stay at 100%, and these runs do not establish whole-app coverage. Each staging tree was removed immediately after its run with guarded cleanup.
