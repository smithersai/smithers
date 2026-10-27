---
title: Bug bash W12 docs accuracy
status: done
area: docs
owner: bb2-docs
updated: 2026-10-27
links: []
---

Reconcile hosted quickstart, screenshots, flow terminology and documentation links with production. Library catalog: @smthrs/ui (existing product UI); documentation uses the existing Starlight projection, no new dependency.

Production probes reproduced the stale quickstart, old palette/release banner, installation link, model tier copy, scheduling words and missing-page message. Heading permalinks already have meaningful accessible names; the code-copy button is named by its title. Contributor avatar links are named by image alt text. The VibeLang body link is repository content owned outside this change.

Coordination with bb2-notfound: the quickstart now distinguishes “Sign in to clone” for an uncloned repository, “Not found” for a missing or inaccessible repository, and an error for a failed lookup. After deployment, compare these three states with the finished recovery page; do not describe a failed lookup as absence. W11 already hides clone controls for authoritative absence.

Nine source regressions fail on the fetched baseline and pass on the changed source. Production specs: docs-site, docs-copy, docs and the scheduling navigation in issue-lifecycle. Production remains unchanged until the lander deploys the site and app and updates the hosted repository home.

Latitude app typecheck, importRules and lint pass; 71 focused tests pass with 100% statements, branches, functions and lines on docs/contract.ts, issues/lifecycle.ts and personal-model/copy.ts. TSX/CSS remain outside configured instrumentation. Site typecheck, lint and 17 focused tests pass. The first root docs sync and check completed; all 51 published tarballs passed. Final root sync/check also completed after the Node API documentation label fix: 51 tarballs passed, flow status completed, runner exit 0. No mini run, deployment or changed-build production pass is claimed.
