---
title: Round two accessibility and keyboard navigation
status: in-review
area: accessibility
owner: bb2-a11y
updated: 2026-10-27
links: []
---

Use the catalog's @smthrs/ui components and existing TanStack Router integration.
Verify W11 chrome fixes before changing layout. Reproduce production findings,
retain a regression per fix, and deliver to the lander without deploying.

## Fixed

- AY1: Chat has a level-one heading without extra visible chrome.
- AY2: plural pull-request item URLs redirect to the canonical singular route.
- AY4: the Make TODO shortcut is hidden from its accessible name.
- AY5: docs sidebar section labels no longer interrupt heading navigation.
- AY7: protocol names distinguish model credential fields without extra visible copy.
- AY8: the first keyboard stop skips to current content.
- AY9: existing landing identity and source link supply banner and footer landmarks.
- AY10: one named message log; timeline navigation stays outside it.
- Keyboard: pathname changes focus the new heading or main; filter changes retain focus.
- Keyboard: composer/model-settings entry precedes message history in keyboard order.
- Keyboard: New issue focuses Title once and preserves Description focus while editing.
- Locale: browser language and script determine document lang and dir, including explicit script overrides.

The UI catalog entry is `@smthrs/ui`. `PageFocus` is public SDK infrastructure;
its lifecycle hook stays out of the app as ImportRules requires. No new dependency,
storage schema, flow, permission, or remote write is introduced.

## Other findings

- AY3 is not a toggle bug: Accept and Not accepted are actions, hidden once current;
  the triage badge exposes current state. TODO links retain their product numbers in
  the named TODO region. L5 is not a bug: the production accessibility tree names
  avatar links from their image alt text, including codeplanesmithers.
- AY6 remains deferred: signed-out Cloud runs fetch returns 401. The production
  probe confirms it. Fix needs session-aware cloud-list loading and recovery on sign-in.
- Locale issue loading and big-screen B4 reuse W11's issue-list feedback/scoped-shape
  fixes. Arabic bell overlap and B1 timeline clipping reuse W11 chrome fixes.
- Relative-time translation and grouped counts remain deferred: document direction
  does not translate the SDK's English copy.
- V1/V3/V5/V9 remain deferred: shared page-container, primary-action and empty-state
  harmonization spans the SDK and screens; preserve the documented code/run layouts.
  Existing flows and secrets already use the shared EmptyState; the difference is
  their surrounding list/card composition.
- V2/V4/V8 and B2/B3 are not independently actionable defects: repository-authored
  homes, contextual page headers, the compact chat column, model-key gate, and
  reading widths are documented feature choices. No new layout is inferred.
- V6, V7, V10, D3 and big-screen B5 remain deferred: repository-authored home grid,
  docs-site theme/version, model column alignment, and startup performance require
  their own visual/performance validation. They do not block keyboard testing.
- The keyboard probe's old Not found repository cards remain deferred; this run
  did not establish whether their persisted repository references still exist.

## Lander validation

Run `accessibility-*.spec.ts` against the deployment, with a Member and
`E2E_SYNCED_REPOSITORY` naming its synced repository. The specs read GitHub only;
the New issue spec types a local draft and never submits it. Check a visitor's
Chat heading at phone and desktop widths as well. Re-run W11 chrome specs for
bell placement and timeline labels, including 2560px. No mini, deployment, new
production E2E, GIF, or after-deploy success is claimed by this builder.

## Validation receipts

Latitude app typecheck, importRules and lint pass. Four focused files contain
29 passing tests. documentLocale.ts and NewIssueForm.tsx reach 100% statements,
branches, functions and lines in that run. SDK typecheck and its complete 2,666
test suite pass; page-focus.tsx and ChatTranscript.tsx each reach 100% lines and
functions under Bun (which does not report branch/statement coverage). Other
app TSX changes remain outside the repository's configured coverage gate; their
deployment specs are retained, without a new-build browser-pass claim.

The first SDK run exposed a test that remounted its focus component rather than
keeping the router outlet mounted, and the SDK's required JSX pragma. Both are
corrected and the complete SDK suite is green. The app import rule forced the
focus lifecycle into the public SDK, and lint required documenting the expected
malformed-locale fallback; both final gates pass.
