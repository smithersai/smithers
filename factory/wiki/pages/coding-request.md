# From a prompt to a measured coding outcome

`coding/request` is a private repository flow whose module is the `coding/Request` flow, so it names no delegate. Its input is `{ prompt, feedback?, maxRounds? }`. It is not a public Smithers package API: the gateway keeps its existing plan, approval, run and watch operations, with no additional endpoint, database, queue or executor.

## Compose ordinary native children

`coding/Request` prepares a plan with a `PrepareRequest` child, admits that plan's source with `AdmitSource`, then hands the prepared plan to a private `coding/CoordinateRequest` child. A stack request with a `base` first stands on a fresh working change before preparing.

The coordinator receives feedback before implementation. With no new messages it admits the source again and runs the bounded `CorrectPlan` child, then receives feedback once more after correction. With no messages at either boundary it finishes with `{ plan, outcome }`.

Prototypes are not part of this request. `coding/Prototype` is a separate opt-in flow that prepares and admits source, runs the disposable `Poc` child, then admits the source again; it can neither enter correction nor land.

## Fence the inspected source

`AdmitSource` compares the observed native head and base with the prepared plan and refuses a changed source. Legacy plans without `observedHead` cannot pass this admission. Admission is an initial check, not a lock for the whole run; later native mutations keep their own operation-level fences.

## Read the domain result

The result pairs the final prepared `plan` with the correction `outcome`, whose status is `validated`, `changes-requested` or `blocked`. `maxRounds` defaults to three and admits one through eight; the first implementation counts as a pass. A `blocked` outcome carries the actual failed execution ID and does not assert validation, even when the surrounding engine run completed.

## Apply feedback at safe boundaries

A message delivered before implementation causes another planning pass before any mutation. A message delivered during implementation waits for correction to settle, then triggers a new plan against freshly gathered source. The coordinator never edits an executing plan or interrupts a writer.

The coordinator cursor is ordinary durable Flow payload driven by the existing trampoline. There are at most eight planning passes; reaching that limit is a typed refusal naming the retained message IDs. Merged feedback keeps the exact message IDs, text and provenance, and nothing is silently truncated.

The empty final after-correction receipt closes the coordinator for new feedback. A message that wins that race is drained and replanned; a later message is refused, and the caller can start another request.
