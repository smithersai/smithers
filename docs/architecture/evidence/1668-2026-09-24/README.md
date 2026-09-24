# Release parity remains blocked

Issue: [#1668](https://github.com/smithersai/smithers/issues/1668). This evidence does not close the issue, its architecture children, or [#1655](https://github.com/smithersai/smithers/issues/1655).

## Authenticated target reproduction

[Release dry run 36055720067](https://github.com/smithersai/smithers/actions/runs/36055720067) completed with **failure** on 2026-09-24. It requested source `19c97074b05d3727b87283d5f4c8223eddcaeb2a`, using workflow implementation `b98a2507c8739dc29ca2ffc405ae5ebe5695c2a4`. The rehearsal label was `v1.0.0-rc.1-parity.1668`, with `dryRun=true`; no package or deployment was published.

The configured target was `https://canary.smithers.sh`. With the existing repository secret `SMITHERS_MODE_MATRIX_PLUE_TOKEN`:

- `/api/bootstrap` returned HTTP 200 and cloud UI build `19c97074b05d3727b87283d5f4c8223eddcaeb2a`.
- Authenticated `/api/user` returned HTTP 404. This is the same required product endpoint that stopped the earlier packaged native topology test.
- The preflight failed, and the native helpers, native matrix, Linux publish job, and docs deployment were skipped.

The archived [preflight receipt](plue-preflight.json) is an exact copy of artifact `release-plue-preflight`, ID `10832078155`, from that run. Its downloaded ZIP SHA-256 was verified against GitHub's digest: `7f24ef57021668107511b101e8bbfe160c8dc2f0ffa1c57bf99f28c4a90d6e18`. See [artifact metadata](artifact.json). The receipt contains no credential or user identity.

This establishes a reachable UI bootstrap and a failing authenticated product route. A UI `buildSha` does not identify Plue's backend library, image, or execution artifacts. No pinned product artifact set was produced by this run.

## Required evidence status for this candidate

| Mode | Product result | Evidence |
| --- | --- | --- |
| web-selfhost | Not executed | Preflight prevented Linux matrix startup |
| web-plue | Not executed | Configured target failed authenticated product API check |
| local-own | Not executed | Preflight prevented Linux matrix startup |
| local-plue | Not executed | Configured target failed authenticated product API check |
| native-own | Not executed | Preflight prevented packaged native matrix startup |
| native-plue | Not executed | Configured target failed authenticated product API check |

These rows are an execution-status inventory, **not six passing mode receipts**.

| Other acceptance evidence | Result |
| --- | --- |
| Clean public installation with managed domains denied | Not executed; no denial receipt |
| Coordinated backup/restore | Not executed; no restore receipt |
| Live GitHub import | Not executed; no live-provider result |
| Live model/tool smoke | Not executed; no live-provider result |
| Plue fleet/replica failure cases | Not executed; no infrastructure receipt |
| Production rollout | Not performed or certified by this rehearsal |

## Earlier sampled Release

[Run 36033793252](https://github.com/smithersai/smithers/actions/runs/36033793252), source `b9756427bd4ccddf8e1235802097edeab3d884f1`, also failed. Its [job and artifact snapshot](sampled-release.json) records:

- Native topology stopped on `/api/user` HTTP 404, before the product native modes.
- `Workspace targets` failed 7 of 417 targets: `//packages/rpc:fmt`, `//packages/smithers/agent/std:fmt`, `//packages/smithers/flows/platform-node:fmt`, `//packages/testing:lint`, `//packages/smithers/build:test`, `//packages/smithers/flows/platform-node:test`, and `//packages/smithers:test`.
- PostgreSQL backup/restore, distribution build/test, and the four-mode product matrix were skipped.
- Only three native-helper artifacts were retained. No product matrix or release-candidate artifact was archived.

Results from this earlier source are not combined with the newer source to claim parity.

## Work needed to close

Configure a Plue candidate exposing the shared product API, with an authorized matrix credential and the backend/library/runtime/image pins for the selected Smithers release. Run the existing six-mode suite on that candidate and retain its execution and scenario receipts, real backup/restore and managed-domain-denial evidence, and explicit live GitHub/model results. Record production rollout separately. Missing or skipped evidence cannot close an acceptance item.

The accompanying change only moves target diagnosis before expensive builds and preserves failure evidence. Local validation passed 137 preflight/release-rehearsal/release-gate tests and actionlint; those are deterministic checks of the release tooling, not product parity.
