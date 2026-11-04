---
title: Prove pull request review in production
status: blocked
area: app
owner: Codex GPT-6.1 Sol (e2e-pullreview)
updated: 2026-11-04
links: [../features/pulls.md, ../decisions/0129-review-on-request.md]
---

Replaced the stale `vibelangOpenPull` requirement with a real pull request prepared by the spec as the test account on its configured scratch repository. A valid fixture is reused with a new commit; a missing or invalid fixture is replaced. Require `started: true`, successful Checks on that head, then an idempotent second request and exactly one `COMMENTED` bot review on GitHub. Review reads are paginated. The PR stays open and unmerged.

The account is Admin on its own scratch repository and Member on the existing shared scratch repository. The latter supplies real below-Maintainer UI and API coverage with the same account, without a simulated role or a second account. Exact PR/head and run links become test annotations before waiting for completion.

The spec declares `model:read` to keep the account's connection stable through Review, and an exclusive `pull-review-fixture` lease through the complete proof so another run cannot advance the reused head. Fixture setup separately leases the unrecorded GitHub profile. The production runner's new resource admission on main superseded this lane's interim lock-polling change; that change was dropped during rebase.

Catalog: the existing `@smthrs/integrations` GitHub adapter and `@smthrs/flow` review flow remain the product path. Fixture preparation uses the test account's leased GitHub browser profile, outside recorded app contexts, as the deployment sign-in setup does; no new dependency or product runtime.

Production: the Contributor case passed against the account's real Member permission, including the API's 403. The Maintainer case created/reused its own open scratch pull request, showed the exact head's file, and received `202 { started: true }`; the new head's review then failed. Read-only production inspection identified the actual cause: the account's own `review` model call on tier `hard` ended `quota_exceeded`, with zero input/output tokens. Restoring that account's model credit or supplying a funded replacement key is required for a successful production review; no completion is claimed. Its check UUID currently links to an unindexed engine run, so investigation used the durable journal and personal usage ledger directly, without logging provider messages or credentials.

The review's existing `checks.review` log now records its failed model stage and typed error code, including an empty answer, and retains a provider status when available. Its span records the outcome and error code; the existing check counter still counts the outcome. Regression coverage injects quota/content-policy failures and an empty answer through the model service, checks the failed row and absence of a GitHub review, and asserts the log excludes the provider message.

Validation after rebase: all four `pnpm typecheck` projects, all 69 target declaration tests, all 21 resource-lock tests and the 28-case Checks suite passed on the mini. The final three diagnostic cases also passed after strengthening provider-status assertions. The Contributor run produced a passing video and GIF. Private lane STATUS holds PR/head/run correlation, full receipts and pushed revision IDs. Deployment belongs to the lead.
