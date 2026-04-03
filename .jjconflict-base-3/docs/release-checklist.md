# Release Checklist

Last updated: 2026-03-12

## Preflight

- [ ] Confirm target branch/tag and release channel (`canary` or `stable`).
- [ ] Confirm desktop/CLI artifact patterns match real output paths.
- [ ] Confirm smoke scripts pass locally (`bun run smoke:release`) when validating release changes.
- [ ] Confirm `CHANGELOG.md` has pending entries for this release.
- [ ] Confirm runbook owner and rollback owner are assigned.

## Workflow execution

- [ ] Trigger release workflow for intended channel.
- [ ] Confirm all OS matrix jobs complete.
- [ ] Review `artifact-manifest.txt` in each uploaded bundle.
- [ ] Confirm artifact naming contract passes validation.
- [ ] Confirm `SHA256SUMS.txt` is present and includes all artifacts.
- [ ] Confirm no placeholder artifacts are present.

## Validation

- [ ] Desktop artifact smoke test passes.
- [ ] CLI artifact smoke test passes.
- [ ] Packaged UI connects to daemon.
- [ ] Known issues are recorded in release notes.

## Publish and communication

- [ ] Publish artifacts to the agreed distribution endpoint.
- [ ] Publish release notes.
- [ ] Announce availability and known limitations.

## Rollback readiness

- [ ] Last known good release reference is documented.
- [ ] Rollback trigger conditions are reviewed.
- [ ] Rollback comms template is prepared.
