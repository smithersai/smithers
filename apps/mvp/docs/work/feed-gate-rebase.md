---
title: Rebase and squash the feed stack for the receipt gate
status: in-review
area: auth
owner: codex-feed-gate
updated: 2026-11-03
links: [feed-round6.md, reviewfeed-round5.md]
---

Rebase onto fetched main, preserve both sides' behavior and published migrations, compare mini typecheck and the expanded suites by full failing test name against main, squash the tested tree into one commit, then run only the requested receipt review. No landing or push.

Main is pinned to 580a22d5c3165c1df6799e79400fa3788e7d52b2. Incoming migrations 0097–0101 become 0101–0105; incoming decision 0154 becomes 0155. Existing main migration bytes stay unchanged. Library catalog: existing Effect SQL, @smthrs/effect-electric and durable execution host; no new dependencies.

Rebase conflicts combine main's bounded role-check admission and role-stage diagnostics with the stack's early renewal, cooldown, visibility and feed fences. Keep both sides' tests. Receipts: /private/tmp/feed-gate-20261103/.

Red-first rebase repair: `red.stderr.log:36–56` records both inherited stalled role-check cases returning `unbounded`; `red.stdout.log` has 2 failed and 62 filtered skips, with typecheck passing. The start timeout is preserved in the shared early-renewal helper, for cookies and bearers. All 64 SignIn tests pass in the subsequent expanded runs.

The first expanded stack attempt has 694 passed, 1 failed and 25 unexecuted: the auth test `an answer outside the contract, none in time, or no network is unreachable too` exhausts its one-second polling default while startup is still running. Its helper now waits for the SDK live-query row stream. The unexecuted RecheckRole suite reports `PgConnection: Connection timed out` during schema acquisition; the exact reason for that one connection timeout is not established. Sequential runs execute all 25 cases successfully. No retry or connection-timeout increase was added.

The next attempt has 719 passed, 1 failed, no skips: `a stopped pull shape settles a direct page and Try again installs its recovered batch` sees `unknown` before its arbitrary five-second wait ends (`final.stderr.log:3405–3424`). The role read takes 5982 ms; setup logs separately record an 8026 ms engine build. The test now observes the public query through the SDK LiveQuery row stream and keeps its refusal assertions and overall deadline. An intermediate attempt tried to access the private PullsStore: typecheck rejected it and the owned farm invocation was cancelled (exit 143); it is not validation evidence.

Final source validation is `ready.*` in the receipt directory: all four typecheck projects pass; 720 app tests across 27 files, 115 Electric SDK tests and 33 Cloudflare host tests pass, with zero failed or skipped. The two supplementary files cover both sides of the audit conflict and feed redaction. The supplementary result is 17/17: **885 passed overall, zero failed or skipped**, with no stack-only or shared failing names in `comparison.json`. The one main-only failure and absent names remain explicit.

Main's comparison run has 657 passed and 1 failed app test, plus 112 Electric and 33 Cloudflare tests passing, no skips, and all four typecheck projects passing. Its sole failing full name is `worker/github/RepoRoles.test.ts > a rate limit's hold ends GitHub's wait after the refusal, however long the cleanup waited, and answers what is left of it` (7944.197 ms versus a 3400 ms bound). That name passes on the stack. Comparisons preserve file-relative full names, parameter values, absent names and unexecuted cases separately; earlier failures and cancellations are retained, not relabelled as baseline passes.

The temporary source-only main workspace has been forgotten and removed after retaining its receipts. The combined commit’s source-tree equality check is retained in `squash-tree.diff`. Only the requested receipt gate reviews it. The gate result belongs to its external receipt for that exact combined diff. Nothing is landed or pushed.
