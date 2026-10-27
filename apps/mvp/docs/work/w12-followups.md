---
title: W12 production followups
status: in-review
area: app
owner: codex-w12-followups
updated: 2026-10-27
links: []
---

Fix the classified W12 production failures with red-before-green regressions.
Base: production W12 70fb45b0. W13 reports checked: bb2-webkit, bb4-writes,
bb4-views, bb3-cli, bb4-app2, bb4-docs. Preserve their adjacent changes;
bb5-app owns issue-sync rate-limit recovery. No push or deployment.
Libraries: @smthrs/ui (layout, completion), @smthrs/plugin (view authorization),
@smthrs/flow (existing durable reads), @smthrs/effect-tanstack-db (test stores).
Validation runs on Latitude; production reruns belong to the lander.


NEEDS-DECISION: how should a first signed-out visit establish absence after the
anonymous quota is spent? Keep the current honest rate-limit state (no permission
change); use authenticated reads for arbitrary public names (expands what can spend
the deployment token); or verify through GitHub's public git endpoint (a separate
protocol with its own outage/private-repository ambiguity). This change keeps the
current policy. bb5-app owns issue-sync recovery under this limit.

Production data prerequisites: E2E_ABSENT_REPOSITORY must have a fresh authoritative
404 primed through a Member's authenticated About read with a working read token;
E2E_UNSYNCED_REPOSITORY must be public, real and unsynced. A failed preflight is
red, never accepted as absence. E2E_FAILED_RUN retains real failure attempts and
skipped steps. E2E_REPOSITORY_RUN identifies real actions history on
E2E_SYNCED_REPOSITORY. E2E_EMPTY_SECRETS_REPOSITORY must be the deployment's own,
the test account exactly Member there, with an empty real secrets snapshot. These
are explicit blocked prerequisites when absent; no fabricated rows or secrets are
created. Tree redirects first complete the real mirror and verify README.md exists.

W12 shared NotFound replaces the old empty-state selector and Not Found casing.
VibeLang's W12 production declared home supersedes the old design JSON's tagline
and contribution prose; the updated journey still asserts that people alone merge.


W12 regression receipts: the shared skip link's translated box, account truncation,
and duplicate tier purpose IDs reproduce on the unchanged production base.
Latitude's focused real-browser layout checks now include keyboard exposure and
full account-name geometry at tablet width. Header bells use normal wrapping flow.
Keyboard command acceptance re-resolves the exact name/prefix from the current
catalog instead of trusting a displaced row index; explicit pointer choices remain.
The SDK already ranked slash names correctly; the app now uses that grammar at the
keypress boundary too, through ChatComposer's existing textarea event hook.


The old tree redirect failure did not establish why the variant remained a tree.
W12 intentionally bounds alias verification (navigation.md); a deadline is not a
missing file. The spec now verifies a real mirror, main, the exact tree entry and
blob before exercising the alias. New repo.alias.check records/counters/spans
separate verified files, unconfirmed paths and deadlines, retaining the bounded
navigation behavior. The lander must confirm that production variant; no original
failure explanation is inferred from the unavailable browser evidence.


Lander production reruns (apps/mvp/e2e): mobile.spec.ts, settings-layout.spec.ts,
docs-copy.spec.ts, bug-door.spec.ts, bug-report.spec.ts, missing-items.spec.ts,
missing-repository.spec.ts, visitor-credentials.spec.ts, repo-browse.spec.ts,
long-blob-path.spec.ts, tree-file.spec.ts, accessibility-docs.spec.ts,
accessibility-pull-alias.spec.ts, accessibility-todo-name.spec.ts,
accessibility-skip.spec.ts, markdown-rendering.spec.ts, vibelang-visitor.spec.ts,
vibelang-contributor.spec.ts, slash-commands.spec.ts, run-records.spec.ts,
settings-secrets-empty.spec.ts. Supply the real prerequisites above first.


Latitude validation: typecheck, importRules and lint pass. The final focused run
passes 370 tests in 21 files; all six changed covered production .ts files have
100% statements, branches, functions and lines. Existing TSX coverage scope is
unchanged; real browser/DOM tests cover skip geometry, account text, header controls,
unique descriptions, sign-in recovery, and actual composer Enter. The original
source fails eight targeted assertions, two alias diagnostic assertions, and the
real composer DOM regression. The existing @smthrs/observability relay carries the
new credential-free records. New-build production E2E/GIF and full-suite gates
belong to the lander; the original tree failure still needs production confirmation.
