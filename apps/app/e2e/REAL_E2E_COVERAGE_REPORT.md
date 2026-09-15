# Real UI E2E coverage

The `e2e/real` suite contains 140 no-mock Playwright scenarios across authentication, repositories, issues, pull requests, changes and reviews, chat/tools, files/code intelligence, targets, terminals, workflows, run inspection, navigation, persistence/preferences, Wiki, approvals, workspaces, admin, search, plugins, notifications, sync, and Cloud auth. The real runner rejects chat stubs, intercepted service responses, and incomplete host identity.

The current structural gate inventories 326 built-in actions, 140 scenario declarations, and 326 visible gaps, with zero structural errors and six refusal assertions requiring manual review. See the generated machine report in `apps/app/test-results/real-e2e-coverage.json` and the detailed missing-action artifacts.

On 2026-09-15, the production canary against `https://smithers.sh` build `8e388b4081d247c8ac08df785b66cc2791acc3ca` ran nine portable persistence scenarios in 38.2 seconds: Wiki edit/links/delete/reload/restart, appearance reload, and single-line/multiline/clear composer draft reload. All nine passed with zero failures and zero cleanup failures. Authenticated private repository, Cloud workspace, terminal, workflow, and run scenarios remain fail-closed at the real GitHub App readiness preflight and are not counted as passes.

Missing high-value areas are approvals/triggers, the complete Cloud workspace lifecycle, admin authorization, Connector/Linear flows, PR/review mutations, target run history and retry/signal controls, search/palette source actions, plugins/notifications/sync, and packaged native-host coverage.
