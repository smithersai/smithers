# Real UI E2E coverage

The `e2e/real` suite contains 113 no-mock Playwright scenarios across authentication, repositories, issues, pull requests, changes and reviews, chat/tools, files/code intelligence, targets, terminals, workflows, run inspection, navigation, persistence/preferences, and Wiki. The real runner rejects chat stubs, intercepted service responses, and incomplete host identity.

The structural gate currently inventories 321 built-in actions, 113 scenario declarations, 133 distinct declared actions, and 327 visible gaps: 188 missing action declarations, one missing native host, and 138 unexecuted host records (67 local and 71 production). Three refusal assertions require manual review. See the generated machine report in `apps/app/test-results/real-e2e-coverage.json` and the detailed missing-action inventory in `.artifacts/coverage-audit-s16.md`.

On 2026-09-15, the production canary against `https://smithers.sh` build `8e388b4081d247c8ac08df785b66cc2791acc3ca` ran nine portable persistence scenarios in 38.2 seconds: Wiki edit/links/delete/reload/restart, appearance reload, and single-line/multiline/clear composer draft reload. All nine passed with zero failures and zero cleanup failures. Authenticated private repository, Cloud workspace, terminal, workflow, and run scenarios remain fail-closed at the real GitHub App readiness preflight and are not counted as passes.

Missing high-value areas are approvals/triggers, the complete Cloud workspace lifecycle, admin authorization, Connector/Linear flows, PR/review mutations, target run history and retry/signal controls, search/palette source actions, plugins/notifications/sync, and packaged native-host coverage.
