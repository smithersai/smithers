---
title: Bug bash round 4 sign-in return paths
status: done
area: security
owner: bb4-security
updated: 2026-10-27
links: [../features/sign-in.md]
---

Confirmed p4-security-1: dot-segment normalization produces a protocol-relative
return path. W12 reports contain no overlapping fix. Reproduced from the fetched
worker source before editing; production remains W11.

The production denial callback also reproduced an off-site `303`: starting with
`/.//first.example/.//second.example` returned `//second.example?sign_in=failed`.
The request used a fresh visitor attempt, never followed the redirect or redeemed
a GitHub code, and changed no GitHub data. No authenticated production success
callback was exercised.

## SECURITY handling

Validate the normalized path and origin before storage and at both callback
redirects, including attempts created before rollout. Keep targets, state,
cookies, codes and tokens out of diagnostics. No disclosure, GitHub writes,
deployment or Desktop security file edits are authorized in this workstream.

Audit every worker redirect; retain red-first regressions and a deployment spec.
Validation runs on Latitude; the Mac mini is unavailable. Production acceptance
of the new build belongs to the lander after deployment.

## Redirect audit

All five worker redirect call sites were checked:

- Local sign-in already calls `returnPath`; the normalization fix covers it.
- GitHub authorization uses `GitHubAuth`'s configured web origin and fixed OAuth
  authorize route, not the return path. No matching defect.
- Successful callback now revalidates its persisted path for rolling updates.
- Failed callback now revalidates before adding the failure parameter; the nested
  authority reproduction above demonstrates the same bug in this path.
- `worker/index.ts` adds a slash to allowlisted docs paths and emits an absolute
  URL with the request's origin. No matching defect.

Library catalog: existing `@smthrs/integrations` GitHub authorization adapter;
Effect HTTP responses remain in the existing core authentication boundary. No
dependency or SDK API changes.

## Validation

Builder implementation complete; production acceptance remains with the lander.
Three regression cases failed on the old worker before the fix. Final Latitude
checks passed: app typecheck, importRules, full lint, 51 sign-in tests and 25
run-credential tests. `worker/SignIn.ts` reached 100% statements, branches,
functions and lines. Cases cover stored and local paths, successful and denied
callbacks from older attempts, query decoding, encoded dot segments, literal
encoded separators, backslashes, tabs and preservation of safe query/fragment
data. Existing injected GitHub test services are retained; no module mocks or
request interception were added.

The deployment spec `e2e/sign-in-return-path.spec.ts` uses fresh visitor cookies
and real sign-in storage, then denies the attempt without redeeming a code. Its
nested-authority case fails on W11 as demonstrated above. After deploying, run
that spec and `e2e/sign-in.spec.ts`'s `github` group against the deployment. No
new-build browser pass or GIF is claimed: the mini is unavailable, browser suites
cannot run through lat-run, and this builder cannot deploy. Private validation
logs stay outside the repository.
