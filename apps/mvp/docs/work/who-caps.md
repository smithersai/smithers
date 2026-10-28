---
title: AUTH-8 conversations and clone cap
status: in-review
area: auth
owner: auth-fix2 (Codex)
updated: 2026-10-28
links: [../decisions/0122-who-may-ask.md, ../features/repo.md, ../features/sign-in.md]
---

READY for the lander: unchanged main `0452688f` and candidate product code `14ed9812` both pass the full app suite
back to back on the same Latitude host and slot, with the normal Vitest configuration. This continuation changes
only this qualification note. Nothing is pushed or deployed; production qualification remains with the lander.

The lead narrowed AUTH-8 in decision 0122: a stranger may ask, read and clone as a Member of their repository with
their own model. First-run guidance and the slash-issue navigation and repository-role menu fixes are retained.
Hosted inference and every machine entry point require membership of the deployment repository independently of
repository access. This includes terminal attachment, branch Publish/Update/Resync and TODO steering.

The terminal refuses before selection or dialing. Demotion, sign-out or a different signed-in identity closes the
attachment scope and its reconnects before showing the refusal. Sandbox tools refuse permanently without retrying.
The clone cap counts distinct existing repositories from clone feed records under the existing import lock; failed
clones count, same-repository retries add nothing, and another person's retry cannot erase the original act.

Per-person sandbox hours and concurrent TODO-machine accounting are removed, including migration, configuration,
ledger, lifecycle extensions and tests. The old work is preserved at `held/sandbox-accounting` (`7ec478c2f664`) for a
separate design after P1 defects through nine Astra rounds. The only retained migration is `0072_role_observations`.

Libraries: @smthrs/flow, @smthrs/ui, @smthrs/effect-tanstack-db, @smthrs/effect-code-storage, Effect Config and SQL.

Validation on Latitude: typecheck, importRules and lint pass. Old-code proofs fail 21 assertions against main, one
clone-requester regression against the held stack, three pre-dial terminal cases and four live-authorization cases.
The final terminal suite passes 60 tests at 100%. Astra 10 found three alternate machine doors; 11 found selection
before refusal; 12 found reconnect after demotion. Those are fixed. Astra 13 found no actionable P1/P2 findings.

The earlier full run had 12 failures, including two auth-state waits, all passing on focused rerun. The paired full
runs now clear that gate: main passes 5,794 tests in 444 files; the candidate passes 5,901 tests in 449 files. Both
have zero failures, three expected failures and 23 skipped cases in seven skipped files. Both exit 0 with 100%
statements, branches, functions and lines. Every earlier failed case passes in both full runs; the earlier failures
did not reproduce, so no cause is asserted from these passing runs. No timeout, skip or coverage gate was changed.

Both runs execute `pnpm vitest run` with the normal configuration and the runner's existing four-worker limit.
The host was checked before selection and before each run, with ample idle CPU and memory. Main takes 1,310.3 s,
then the candidate takes 1,344.3 s in the same slot. Builder evidence: `paired-main-full.log`,
`paired-candidate-full.log`, `paired-results.json` and the `paired-*-load-*.log` host samples.

The final focused run passes 2,309 tests (107 files passed, one skipped; four live cases skipped), at 100% statements,
branches, functions and lines across 55 measured changed logic files. Eleven full-run failures pass in that run;
the remaining issue-commitment case passes separately against the real handler (diagnostic coverage disabled). The host-model default is now tested through the
real endpoint with both defaults. No production code changed after Astra 13, and no coverage threshold was lowered.

Production qualification remains with the lander: who-may-ask (only reads), first-run (the first page), sign-in
(github) and chrome-visitor. This workspace has not been pushed or deployed.
