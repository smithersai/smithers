# Documentation Index

## Start Here

- [Project README](../README.md)
- [Getting Started for Smithers Developers](./getting-started-smithers-developers.md)
- [Contributing](../CONTRIBUTING.md)

## How To Develop Burns

- [Repository Guide](./repository-guide.md)
- [Desktop Runtime Package Notes](../apps/desktop/README.md)
- [CLI Runtime Package Notes](../apps/cli/README.md)
- [Web App Package Notes](../apps/web/README.md)

## Reference

- [Codebase Layout](./codebase-layout.md)
- [Daemon API Reference](./daemon-api-reference.md)

## Product And Background

- [Product Spec (target state)](./burns-spec.md)
- [Workspace + Runtime Handoff (Next Agent)](./next-agent-workspace-gaps.md)
- [ADR-0001: Desktop Daemon Bootstrap Mode](./decisions/ADR-0001-daemon-bootstrap-mode.md)
- [ADR-0002: Runtime API URL Contract](./decisions/ADR-0002-runtime-api-url-contract.md)

## Release Operations

- [ElectroBun Release Plan](./electrobun-release-plan.md)
- [Release Automation Reference](./release-automation.md)
- [Release Runbook (Canary + Stable)](./release-runbook.md)
- [Release Checklist](./release-checklist.md)

Release helper commands:

- `scripts/release/create-release-notes.sh` generates a release notes draft for canary/stable.
- `scripts/release/verify-artifact-integrity.sh` produces checksum manifests for collected artifacts.
- `bun run smoke:release` runs desktop + CLI runtime smoke checks locally.
- Promote release notes highlights into the root `CHANGELOG.md` before stable publication.
