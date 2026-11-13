---
title: Refuse implicit jj workspace recovery
status: done
area: sdk
owner: codex-nodejj-stale
updated: 2026-10-21
links: [../../../../packages/smithers/flows/jj/docs/troubleshooting.md]
---

Will requires tooling never to run `jj workspace update-stale` implicitly.
Use the library catalog's `@smthrs/jj` entry for working-copy operations.
Remove recovery from NodeJj (shared by Bun and the host spawner) and the
tracked-file hygiene helper and hidden issue-sweep host. Fail with `stale_workspace`, name the workspace
directory, and require committing or backing up before deliberate recovery.
Disable jj's own `snapshot.auto-update-stale` configuration override too.
Explicit restore, revert and workspace creation remain requested operations;
no other implicit recovery rewrite was found in the jj package or its callers.

Real-jj regression on Latitude: old code deleted the uncommitted file (ENOENT).
Latitude validation: jj 431 passed, 1 skipped; hygiene 36 passed; issue-sweep
host 11 passed. Changed production files have 100% line, branch and function
coverage. jj type checks, source lint and formatting pass. The docs-sync
implementation checks all 51 published tarballs and the redirect map; generated
site API documentation is updated. The full docs:check wrapper was blocked by another agent's heavy lock; its
redirect and tarball check implementation passed directly on Latitude. Astra and Fable reviewed the fix. The hidden host path and its lockf-wrapped
jj commands now refuse stale workspaces with dedicated regression coverage.
