---
title: Operator-issued GitHub read tokens
status: done
area: ops
owner: Codex GPT-6.1 Sol
updated: 2026-11-04
links: [../features/machine-tokens.md]
---

One operator command issues and revokes short-lived installation tokens for repository metadata and issues reads.
Agents hold only the installation token. Tests use the explicitly requested injected fetch boundary.
Library catalog: @smthrs/integrations AppAuth and GitHubClient provide JWT signing, minting and the shared User-Agent.
This is an operator credential boundary, alongside ops/machine-token/issue.ts, rather than an app plugin or background flow.
The small .mjs GET consumer supports existing dependency-light operator scripts; its single anonymous fallback is an
authentication downgrade after 401, not a general retry policy.

The issuer writes a private, non-secret `<out>.json` scope receipt beside the raw token. The consumer uses its owner,
repository names and expiry to keep authentication within scope. `track.mjs` reads Smithers' public issue shape, not
GitHub directly; the other lane's repository and scrub helpers are unchanged.

Validation: the initial cfbox run failed 13 new behavioral assertions before implementation. After implementation,
all 24 expanded token tests passed; the complete ops suite on cfbox's pg image via nyc-01 passed 266 tests, with 15
existing skips. The base-image run had only five existing Postgres-dependent suite failures. A plain Node executable
check caught the SDK's transitive `.vibe` dependency loading without its Node loader; the helper now registers the
shipped `vibelang/register` before importing the SDK, as the existing GitHub proxy does. Test receipts and the guarded
jj-tracked staging script are in the requested
readtoken scratch directory. No live credential was minted for validation. This change is not landed or pushed.

Astra found that URL's native parse errors retain input (and possible userinfo) in an error property. The GET boundary
now replaces that error without a cause; a regression checks inspection and JSON serialization as well as no fetch.
