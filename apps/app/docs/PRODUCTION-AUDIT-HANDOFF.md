# Production audit handoff — 2026-09-16

The audit is paused at the owner's request. The original cloud edit → checks →
Vibe → exact landed commit workflow is **not yet verified end to end**.

## Landed

- Cloud startup waits for the staged coding runtime before repository initialization;
  release downloads honor the guest proxy. Plue `7ca92e2309e3` includes these fixes.
- Git mirror transport fetches complete source history. A changed-ref production
  test independently observed the exact landed commit on GitHub.
- Plue `447607ece769` atomically publishes full-push success and repository mirror
  health. Service and isolated PostgreSQL regressions passed. Helm revision 404
  deployed two healthy API instances; the new health readback still needs a live check.
- UI PR landing, review persistence, recommendations, workspace lifecycle,
  streaming, and accepted-run cancellation passed targeted production scenarios.

## Remaining proof

`e2e/real/cloud-coding.spec.ts` selects an explicitly configured canary workspace,
requires its request/Vibe catalog, submits an edit, and requires exact main commit
and README readback after Vibe. It has not passed. The latest attempt accepted
`run-30`, completed planning, then remained in the prototype stage. Its projection
read returned HTTP 502 during the API rollout. A subsequent read recovered the
same running run; wrap-up cancelled it and independently observed `cancelled`.
Do not count this attempt as a pass or launch a duplicate of an active run.

Fresh README-only imports do not expose `coding/request`: the private coding host
requires explicit `SMITHERS_CODING_PROJECT` configuration and registered real
checks. See `flows/coding/host.md` and `flows/test/canary-coding-setup.mjs`.
The prepared canary uses an older host with a mandatory prototype stage; verify
its host version before comparing its behavior with current source.

The configured runtime catalog/input-form scenario passed. Generic flow creation,
run inspection/steering/rerun, private issue isolation, and full production feature
coverage remain incomplete. The tests preserve failures instead of claiming coverage.

## Resume safely

Use the existing authenticated canary account and coordinate browser-profile
ownership. Never terminate another agent's console. Select the exact workspace
through the UI; a repository alone can resolve a different cloud copy. Run one
owned sandbox fixture at a time, and avoid deployment during the final UI proof.

Local audit receipts and screenshots are preserved under
`~/smithers/.artifacts/production-feature-audit.md` and
`~/smithers/.artifacts/production-audit-wrap/`.
