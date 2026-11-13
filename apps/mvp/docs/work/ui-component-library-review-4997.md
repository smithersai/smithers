---
title: Component library interaction and reference corrections
status: done
area: ui
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4997
---

Fix the twelve component-library findings in issue #4997. Keep changes in
the shared UI package (SDK-1), with real React/DOM regression
tests and the existing CodeMirror parser. Library catalog: `@smthrs/ui`
components; the reference scanner uses the existing TypeScript compiler API.

The fixes cover notice navigation from sibling controls, case-insensitive
JSX languages, citation preview lifetime and navigation, toast burst limits,
current menu confirmations, grouped list items, explicit UTC times, complete
entry-point documentation, strict API-reference checking and empty provenance
cleanup. Stable menu IDs are optional and preserve callbacks across refreshes;
ambiguous anonymous items close confirmation rather than run another action.

Regression evidence: the original source failed 33 targeted assertions.
The stricter reference gate also rejected the original API documentation.
Astra reviewed the changes and its follow-up passed after duplicate-action
removal and mixed pointer/keyboard citation regressions were added.

Validation:
- `bun test tests`: 3115 tests passed.
- `bun test browser/citation.browser.test.ts`: six Chromium probes passed.
  Four gap-crossing probes fail before the grace-period fix, and the
  text-selection probe fails before the inside-press fix.
- `pnpm run check`: UI source and test typechecks passed.
- Browser fixture typecheck and the stylesheet package typecheck passed.
- `node --test scripts/reference-docs.test.mjs`: 27 checks passed.
- The target index was regenerated and its lint gate passed unchanged.
- API-page projection and package-doc redirect parity checks passed.

Astra and Fable follow-up reviews passed. The package defines no standalone
lint script or ESLint/dprint target; no coverage percentage is claimed.
