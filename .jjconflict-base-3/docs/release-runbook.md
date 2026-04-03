# Release Runbook (Canary + Stable)

Last updated: 2026-03-12

This runbook covers operator steps for release execution while ElectroBun desktop and CLI packaging are still being finalized.

## Preconditions

- Release workflows exist and pass lint/sanity checks.
- GitHub Actions variables for build commands/patterns are set only when overriding defaults.
- Build output paths are confirmed by local dry run.
- `CHANGELOG.md` includes candidate release highlights.

## Canary release procedure

1. Ensure `dev` branch is green (tests and typecheck for affected packages).
2. Trigger `.github/workflows/release-canary.yml` from `dev` (runtime smoke checks run automatically).
3. Validate each matrix job produces an uploaded artifact bundle.
4. Verify `artifact-manifest.txt` and `SHA256SUMS.txt` in uploaded bundles.
5. Download and spot-check at least one desktop and one CLI artifact.
5. Publish or distribute canary artifacts to the agreed preview channel.
6. Capture issues in release notes and link to workflow run.

## Stable release procedure

1. Prepare version tag `vX.Y.Z` and stable release notes.
2. Trigger `.github/workflows/release-stable.yml` via tag push or manual dispatch with `version`.
3. Keep strict mode enabled (`strict_artifacts=true`, default).
4. Verify artifact naming contract and integrity checks for all matrix targets.
5. Confirm changelog entry matches stable release notes.
6. Publish artifacts and communicate rollout window.

## Post-release verification

- Smoke launch desktop package on at least one target OS.
- Smoke launch CLI package and verify daemon + web handoff.
- Confirm no regressions in API connectivity from packaged web UI.
- Archive workflow URLs and release notes links in release tracking.

## Rollback notes

Rollback triggers:

- Desktop app fails startup or cannot reach daemon on multiple machines.
- CLI package cannot bootstrap daemon/web consistently.
- Artifact mismatch, corruption, or incorrect target labeling.

Rollback actions:

1. Stop promotion/distribution of current release artifacts.
2. Re-point users to last known good canary/stable release.
3. Create rollback note in `CHANGELOG.md` and release notes.
4. Open incident task with failing workflow run IDs and affected artifacts.
5. Patch release scripts/workflows, then rerun canary before next stable attempt.

Rollback verification:

- Last known good artifacts are downloadable and launch successfully.
- Known-bad artifacts are marked or removed from distribution endpoints.
- Incident issue has owner, remediation ETA, and retest criteria.
