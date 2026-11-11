---
title: Secret values survive header transport
status: done
area: sdk
owner: codex
updated: 2026-11-10
links: [https://github.com/smithersai/smithers/issues/4482, ../../../../packages/smithers/flows/secrets/docs/README.md]
---

Secret values must be printable ASCII without leading or trailing spaces.
The shared validation reports `non_ascii` or `surrounding_space` before saving;
the egress applies the same validation before substituting a stored value.

Regression tests cover Unicode boundaries, every non-ASCII UTF-16 code unit,
every printable ASCII character in a header, typed failures without values,
and stored invalid values refused without forwarding or a forwarded audit entry.

Before the fix, the focused suites had 22 failures: an emoji produced
`502 upstream`, while Latin-1 and surrounding spaces were sent.

Validation: all 141 secrets-package tests passed with 100% statement, branch,
function and line coverage; package typecheck and lint passed. All 199 affected
app tests passed against Postgres, including both save APIs and browser clients.
All four app typecheck projects and lint for changed sources passed.
The direct documentation check passed for all 52 published package tarballs.

The full app lint still reports 18 errors in unchanged files. The documentation
flow cannot pin its execution closure because artifact directory synchronization
fails with `Operation not supported`; its generation step produced no changes.
These validation limitations are retained with the issue's completion evidence.
