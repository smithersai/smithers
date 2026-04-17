# Docs as Contracts: Maturity Labels + CI Smoke Tests

> Target repo: **smithers**
> Source: memo §6 · roadmap Phase 3 (starts now, ongoing)

## Problem

The 0.12.x field report and the current 0.15.x docs describe different
systems. Users trust docs, hit unimplemented or partially-implemented
surfaces, and lose confidence. This is a reliability bug, not a docs bug.

## Goal

Every documented CLI command, HTTP route, event type, and inspector
surface is either CI-verified or visibly marked as aspirational.

## Scope

### Maturity labels

Add a frontmatter field `maturity` to every `.mdx` in `docs/`:

- `stable` — covered by CI smoke tests; will not break without a
  deprecation cycle.
- `beta` — works, covered by at least one test, but shape may change.
- `experimental` — no stability guarantee; explicit warning banner.
- `design` — aspirational; not yet implemented. Must link to a ticket.

Docs site renders a badge for every non-stable page. A `design` page
refuses to describe the surface in present tense — it uses future tense
("will support") and links the spec/ticket.

### CI smoke tests

New `e2e/docs-smoke/` directory. For every `stable` or `beta` page:
- If it documents a CLI command: run `smithers <cmd> --help` and assert
  all documented flags appear.
- If it documents an HTTP route: hit it (on a fixture server) and assert
  the response shape matches the example.
- If it documents an event: assert the event type is exported from
  `packages/core` and matches the documented payload schema.
- If it documents an inspector surface: render it in a test harness and
  assert the documented fields are present.

Missing coverage fails CI.

### Example execution

Every fenced code block tagged `smithers-example` in docs runs in CI
against a fixture. Add `scripts/extract-examples.ts` to pull them out
and run. Broken examples fail the build.

### Linting

- PR template asks: "does this change a documented surface? If yes,
  attach the smoke test update."
- A `docs-lint` rule rejects any `.mdx` without a `maturity` field.
- A rule rejects `design`-labeled docs that don't link to a ticket.

## Files

- `docs/_meta.json` (or equivalent) — maturity registry
- `e2e/docs-smoke/` (new)
- `scripts/extract-examples.ts` (new)
- `scripts/docs-lint.ts` (new)
- `.github/workflows/docs-smoke.yml`
- update every existing `docs/**/*.mdx` with a `maturity` field

## Testing

- Meta-test: docs-lint passes on the repo after migration.
- Meta-test: the smoke harness detects a deliberately-broken example and
  fails.
- Meta-test: removing a documented CLI flag breaks CI with a clear
  message pointing at the doc.

## Acceptance

- [ ] Every `docs/**/*.mdx` has a `maturity` field.
- [ ] Every `stable`/`beta` surface has at least one smoke test.
- [ ] `design` pages cannot describe behavior in present tense (linted).
- [ ] CI runs docs smoke on every PR that touches `docs/` or `apps/`.

## Blocks

- Nothing. Deliverable in Phase 0 alongside 0015–0020.
