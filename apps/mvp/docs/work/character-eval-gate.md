---
title: Character suite channel privacy and counterexample gate
status: done
area: sdk
owner: Claude
updated: 2026-11-12
links: [https://github.com/smithersai/smithers/issues/5025]
---

The character runner scores a reply by its readers: a reply in a `channel:`
is team-visible even when Will wrote the trigger, so the world's private
markers fail the leakage check there.

The offline gate counts a counterexample as caught only when every turn ran
its transcript (each call accepted, the recorded reply returned) and an
expectation check failed. Executor errors, missing transcripts and rejected
replay calls fail the gate. Tests: `character/score.test.ts`,
`character/run.test.ts` in `packages/smithers/agent/regression`.
