# From a prompt to a measured coding outcome

`coding/request` is a private discovered repository flow. It lowers through the existing catalog into `coding/RunRequest` and `coding/Request`. Its input is `{ prompt, feedback?, maxRounds? }`; it uses the ordinary gateway plan, approval, run and watch operations. No new endpoint or execution store is introduced.

## Make each stage observable

The request composes visible native children in this order: verified wiki and first planning, source admission, disposable POC, source admission again, then a coordinator that refreshes wiki, plans from retained feedback, admits the prepared source and runs bounded correction. `PrepareWithWiki` may reuse exact previously supported pages; a refresh is still a real durable child with its own receipt.

The complete `Poc` result remains in that child's durable output. Only its measured feedback is passed into second planning. This is a saved file-level source prototype marked `drafted-unvalidated`; the request does not claim that the prototype compiled, ran tests or produced an executable application preview. The production implementation starts independently of the discarded proposal.

## Fence the inspected source

A prepared Plan includes its full native `observedHead` as well as its base. Those may differ when the plan amends earlier ownership. `AdmitSource` snapshots current bytes through the injected JJ service and compares the measured head and base to that Plan. A changed source refuses the dependent stage instead of silently refreshing its premise. Legacy manually supplied plans without the observation cannot pass this request admission.

Admission is a boundary check, not a lock covering every future instruction. Actual native mutations and checks retain their own parent, operation, commit and executable fences. The host owns exclusive editing coordination; the request does not invent a new locking protocol.

## Read the domain result

The result pairs the final prepared `plan` with the correction `outcome`. Its domain status is `validated`, `changes-requested` or `blocked`. The first implementation counts toward `maxRounds`; the default is three and the admitted range is one through eight.

A completed outer engine run can carry a blocked product outcome with a real failed child ID. A failed child can also be the deliberate early-feedback signal inside a continuing correction. Neither an engine status nor a queued feedback acknowledgement means validation, vibed, landing or shipment. The [coding UI](coding-ui.md) reads recorded domain outputs separately from engine lifecycle.

## Keep host policy explicit

Project configuration owns the public wiki catalog, reviewer policy, registered implementation/check names and model roles. A prompt cannot replace credentials, check commands, source roots or executable digests. Planning and review models receive captured evidence under enforced empty tool authority; the implementation model receives only the approved standard tool context.

The request-host fixture covers the composed wiki, two planning passes, retained POC, native implementation and command checks on injected Node and Bun services. It uses scripted model choices and real platform operations. Live-provider quality and deployed behavior require their own evidence. Final history cleanup, vibing and delivery are later lifecycle work.

## Apply feedback at safe boundaries

Root request messages are received after the POC, before implementation, and after correction. New feedback before implementation causes another prepared plan before any mutation. Feedback arriving during implementation waits for correction to settle, then gathers fresh source and wiki evidence. The POC runs once. The private coordinator uses an ordinary durable trampoline, with at most eight post-POC planning passes and no silently truncated feedback.

An empty final after-correction receipt closes that coordinator for new feedback. Admission checks the existing receipt in its Control transaction: a message admitted first reaches the drain, while a message arriving after closure is refused. An exact retry of an accepted message retains its original receipt. This is a safe boundary protocol, not preemption of a writer or an automatic human pause.
