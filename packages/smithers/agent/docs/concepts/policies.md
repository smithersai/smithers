---
title: "The three policies"
description: "Why quota waits are recorded, why budget accounting fails closed, and why a structured-output correction is a whole cell run: the reasoning behind the agent's three injected policies."
sidebar:
  order: 4
---

A production agent step does more than call a provider and decode the answer.
It has to survive three things the provider does routinely: refuse because a
quota window is closed, answer with something that does not fit the declared
schema, and spend tokens somebody approved a budget for. Three policies carry
those concerns, and all three sit at the model boundary in `FlowEngineLike`,
which every model call in the composition passes through, so a step that
assembles its own loop cannot evade them.

Each policy is injected, required, and declared where the person who cares
about it works. A composition that binds none is a type error; opting out is a
written decision (`QuotaPolicy.layerUnclassified()`,
`Budget.layerUnbounded()`), never an omission.

## Quota: a refusal is a time, not a defect

A `rate_limited` or `quota_exceeded` answer is the provider saying when to come
back. A step that fails on it loses everything the run had done; a step that
waits keeps it and costs the operator nothing but clock. That is why the
classifier exists, and why its answer is bounded: a deadline past
`maxWaitMillis` is not a wait but "this run cannot proceed today", a decision
for whoever is watching the run rather than for the step.

Two design points are easy to miss:

- **The park decision is recorded.** A park is computed from the wall clock, so
  a replayed body that classified afresh would choose a new deadline every time
  and park again on every resume. Recording the decision makes the replay wait
  out the deadline the first pass chose, and puts the wake time and its source
  in the run's own evidence.
- **A capacity refusal is never a durable value.** The engine port normally
  records a provider failure as the sealed step's result, which is right for
  every failure except this one: a quota refusal says nothing about the
  request, because the same bytes succeed a minute later. Recording it under a
  content key would pin "this prompt is refused" into the shared cache and make
  the wake pointless, because the retried call would replay the refusal
  forever. The port therefore fails `rate_limited`, `quota_exceeded`,
  `provider_internal`, and any refusal carrying HTTP 429, 503, 504, or 529,
  recording an attempt rather than a result. That is the recorder's own floor,
  applied before any classifier is consulted; no policy weakens it, including
  `layerUnclassified`.

## Budget: the ledger is the allowance

`Sandbox.Limits` bounds one cell and `maxFrames` bounds one loop, but neither
accumulates, so neither can hold a run to an approved token and millisecond
envelope. `Budget` is the piece that does. Its enforcement is ordinary (a check
before each call); what makes it trustworthy is where its numbers come from.

- **The accumulator is projected from the journal.** The engine resumes a run
  from recorded results and never re-enters a settled step, so an in-memory
  tally would start a resumed run at zero and hand it a second full allowance.
  Every accounted call writes a durable usage record keyed by the step's
  content key, and a budget entering a run folds those records back first. The
  content key is what stops the two sources double counting: a recovered record
  and its own live call are the same key. Reported usage from an unsealed
  capacity failure or interrupted stream has a separate invocation receipt:
  it is still spend, but does not mark a future provider retry paid. The
  latency clock zero is durable for
  the same reason, and the earliest recorded value wins, so a duplicate write
  cannot move the allowance forward.
- **Admission reserves a soft projection.** `reserve` atomically accounts for
  actual spend plus every in-flight forecast. The largest observed call sets
  the forecast; until a positive cost is known, one call holds the full token
  allowance. Zero token, USD, and latency ceilings refuse the first call and
  evaluator readings unless `warn` permits them. Recording usage
  replaces the forecast, and closing the call's scope releases its reservation.
  The first call is not free and a forecast is not a provider billing cap:
  admitted calls can cost more than estimated. All concurrent calls of a run
  must share one Budget instance; separate instances do not coordinate quotas.
- **The accounting fails closed.** A record that could not be written, a
  ledger that could not be read, and a ledger longer than one recovery reads
  are not smaller numbers; they are an unknown number, and answering "proceed"
  to an unknown is how a run that has spent its whole envelope keeps spending.
  So the seam raises `AccountingUnavailable` instead. The step that made the
  call fails, and its sealed model step replays from the recorded answer, so a
  re-dispatch pays the ledger again rather than the provider. The one record
  allowed to be lost is the `warn` notification: nothing reads it back, so
  losing one costs a line in an operator view and no decision.
- **A latched skip is a verdict, not a failure.** `skip-remaining` reports the
  call that broke the budget as `BudgetExceeded` and every call after it as
  `Skipped`, carrying the same numbers. An operator needs to tell the step that
  broke the budget from the steps the broken budget stopped, and a supervisor
  needs to know no retry can change the answer.

## Structured output: the ladder is durable because the step is

The declared schema is rendered into the run's teaching and enforced against
its final answer, and a decode miss spends a correction slot. The interesting
part is what a correction _is_: a whole new cell run under its own session and
its own prompt. That choice buys three properties:

- Its model call is a distinct sealed step with its own content key and its own
  attempt row, so a settled ladder replays whole across a process restart and
  over a second engine on the same database, paying the provider nothing.
- Its identity is unreadable by design (a session is key material and is
  hashed), so the port stamps the ordinal onto the rung's record separately:
  `correction: 0` for the ask, `1`, `2` for its re-prompts.
- Its evidence outlives it. Every rejection writes a record carrying the
  attempt, the budget, the schema digest, and a digest of the issues, because
  the final failure only describes the last candidate. The record is evidence,
  not a decision: nothing reads it back, and a composition without a journal
  behaves identically without it.

A correction repeats the task verbatim with the validation issues appended,
because it assumes the model can still answer the question it was asked. A
repair does not assume that: it is the author's own prompt, written from the
failure, asked exactly once, and decoded by the same schema. That is why it is
a separate slot rather than another rung, and why a repair that misses reports
its own failure rather than the ladder's.

For the procedures, see [Park on quota refusals and limit model admission](../guides/quota-and-budgets.md)
and [Shape a model's answer into typed output](../guides/structured-output.md).
