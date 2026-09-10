# Prompt requests and coordinator feedback

The private `coding/request` executable keeps its existing input: a prompt,
optional initial feedback and an optional correction limit of one to eight.
`RequestResult` remains `{plan, outcome}`. A request completing in the engine
means its result is available; inspect the domain outcome for `validated`,
`changes-requested` or `blocked`. It does not mean vibed, landed or shipped.

## One disposable POC, then current planning

`Request` first calls `PrepareWithWiki`, verifies that its captured native JJ
source still matches, runs the retained disposable `Poc` child, and verifies that
the original source still matches after the POC. The POC's complete measured
source and before/after result remain in its own child history. The coordinator
uses its bounded findings as feedback, preserving the original user feedback.
This is the existing file-level POC; it does not claim an executed browser build.

The coordinator receives queued request messages after the POC, then starts
`CoordinateRequest`. Each pass calls `PrepareWithWiki` again. Wiki publication
and semantic review precede planning, and planning captures the current native
head. The second plan therefore has both the initial constraints and POC
findings. Later passes can also inspect the history produced by earlier
implementation and correction work.

## Feedback at safe boundaries

The configured native host installs the private `routeMessages` decorator and
`feedbackLayer` over its existing control notification queue. The routing,
approved-owner proof and exact durable receipts are described in
[steering.md](steering.md). Every Message addressed to the approved request root
uses the coordinator lineage. Explicit leaf messages and model settings keep
their existing behavior. There is no separate feedback store or transport.

`ReceiveFeedback` runs after the POC, after each prepared plan but before
implementation, and after each completed correction pass. A message delivered
before implementation causes another planning pass before any plan mutation.
A message delivered during implementation waits for `CorrectPlan` to settle,
then causes a new plan against freshly gathered source and wiki evidence. The
coordinator never edits an executing plan or interrupts a writer mid-operation.
The next plan can select existing JJ atoms under the usual ownership policy.
The POC is not repeated on these later planning passes.

The Message receipt is an ordinary completed native Action result. Its exact
notification IDs, text and attribution remain available even if combining the
feedback exceeds the existing 65,538-character planning limit. Nothing is
silently truncated. Queue capacity refusal is returned through the existing
notification error. A receipt that says queued is not evidence that a revised
plan completed: the subsequent actual Plan child is that evidence.

## Bounded ordinary Flow state

A private `CoordinateRequest` cursor contains
`{prompt, feedback, maxRounds, revision}`. `maxRounds` is the existing correction
limit; `revision` counts the coordinator's post-POC planning passes. The cursor
is ordinary durable Flow payload and uses the existing trampoline rather than
a second run loop or ledger. The result does not acquire a duplicated transcript,
POC artifact or collection of earlier plans.

There are at most eight planning passes after the POC, in addition to the
initial POC plan. Repeated messages at that limit produce a typed refusal naming
the retained message IDs. A source admission failure also refuses before
implementation rather than silently updating the plan to a different source.
Existing native per-operation fences still govern every later mutation.

The final after-correction drain and the control run's completion are currently
separate transactions. A Message arriving in that interval can remain pending
after the request completes. It is retained, but does not automatically create
a new request or prove that a revised plan ran. Atomic closure of that interval
is an outstanding integration requirement. There is no claim of preemptive
steering or an implicit human wait after every POC.

## Verification

The coordinator regression suite uses the real Flow engine and interpreter with
explicitly scripted planning, prototype and correction children. It verifies
constraint and attribution retention, feedback before mutation, replanning from
the source left by correction, bounded continual steering, stale source refusal
and completed execution replay. These tests do not measure model quality, native
JJ mutation or operating-system process containment. Those remain covered by
the separate native request, correction and notification host acceptance tests.
