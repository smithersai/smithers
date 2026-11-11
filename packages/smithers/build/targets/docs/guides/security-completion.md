---
title: "Security review completion"
description: "Completion receipts, independent passes, and paired recall measurements."
---

## Completion

Security reviews require a JSON envelope with `status` (`completed`, `refused`,
or `incomplete`), `coverage`, `missingContext`, and `findings`. Coverage lists
every declared check, including `general`, exactly once with a status and
nonblank inspection evidence. Only completed coverage with no missing context
can pass. A bare `[]`, prose refusal, truncated output, or provider failure
cannot become a clean review. Generic model lint still uses a findings array.

Every security review uses three independent passes: the selected engine/model,
the other engine family, then the selected engine/model again. Set
`alternateModel` in `SecurityReview`, `LlmLint` attrs, or the review payload
to select the other family's model for the second pass and candidate verification.
It defaults to `claude-opus-5-5` for Claude and `gpt-6-sol` for Codex. Each pass starts without previous findings. Configure credentials for both model families on the review host. Tool-free
provider requests use `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Each invocation makes one attempt; failures return to the host's durable flow,
which owns retry policy. A review has at most 256 attempts, including verification,
and 8 MiB of attempt receipts. Exhausting a bound fails the review.

The union retains every candidate, including one reported by only one pass.
Each candidate receives a separate source verification by the alternate engine.
Contradicting verification is recorded and cannot erase the candidate or lower
its impact. A verifier can raise the gate by reporting a stronger finding for
the same location and check; unrelated verifier findings fail that attempt. Verification is inspection, not reproduction: only an actual
controlled execution receipt can confirm a finding.

Successful reports and review errors retain attempt receipts with the engine,
model, pass, purpose, result, completion envelope, and failure. Findings
that block release carry those receipts too. Coverage is a model assertion,
not proof that the code is safe.

## Repeated paired evaluation

Run from the repository root with both provider API keys configured:

```bash
node .smithers/flows/review/seeded-bugs/security-completion.ts 3 /tmp/security-completion-report.json
bun test .smithers/flows/review/seeded-bugs/security-completion-score.test.ts
```

The live run checks both keys before it starts and exits nonzero, writing
nothing, when either is missing or blank. It writes progress to
`<report>.partial` and moves it to the requested path only when every review
completed. If any review failed, was refused, or stayed incomplete, the run
exits nonzero and keeps the receipts in `<report>.incomplete`, so an existing
report is never replaced by an unfinished one.

The live run spends inference budget. It reuses the SQL equality and LIKE
injection corpus pairs, reviewing both vulnerable and fixed versions through
`LlmLint.review`. A real in-memory SQLite database reproduces each seeded flaw
with synthetic data and verifies that its fixed version resists the same input.

The report retains source hashes, implementation hash, revision, provider
attempts, reproduction outcomes, per-repeat recall, post-reproduction precision,
refusal rate, incomplete rate, and population variance. Refusal counting uses
explicit refusal statuses and recognized prose snippets; unrecognized prose
remains an incomplete response. A finding matches the
seed only at its SQL sink (within two lines) and with the SQL injection check.
Unmatched candidates remain unconfirmed. No candidates means precision is
undefined, not perfect; failed reviews remain in recall denominators.

Two SQL fixture pairs measure only that narrow corpus. They do not establish
recall across other vulnerability classes. Deterministic protocol and scorer
tests measure pipeline behavior, not model recall. Retain a live report before
publishing any recall claim.
