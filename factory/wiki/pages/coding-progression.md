# Coding progression and validation

`coding/ImplementPlan` expresses the coding policy as ordinary `Flow.make`, `Action.make` and Effect layers. The existing flows runtime stores the plan, action outcomes, child execution relationships and replay state through its injected database; there is no coding database, queue, lease or event store.

## Predict a linear plan

`ImplementPlan` predicts one linear sequence of product Changes. A Change groups native JJ changes; an atom's `changeId` is the JJ ID and stays stable when its commit is rewritten, and a planned new atom has `changeId: null` until JJ creates it. The Change's `id` is a grouping label, not another identity for an atom.

A `Revision` records JJ change, commit, tree, operation and parent commit IDs. Every Change has at least one required fast and one required slow check.

## Advance after the fast gate

The flow validates the plan, then for each Change runs the implementation, its fast checks, and the fast gate. Implementation evidence must form a single parent chain from the exact supplied parent, retain existing atom identities, and end at the reported head. A receipt for a previous revision cannot unlock progression.

After the gate, the Change's slow checks and the next Change's implementation run together in one `Node.all`, so slow checks never become a dependency of the next implementation. Required delivery checks are deferred to the later vibing/landing workflow.

## Assess the whole progression

After every Change, the flow runs a final assessment over the plan and the implemented Changes. A late finding names its owning Change and the actual reviewed commit, so a downstream discovery can request an earlier fix.

Check receipts identify the target, JJ commit/tree and measured input digest. `Receipt.inputDigest` must equal `checkInputDigest(implementation, check)`, the canonical SHA-256 digest of the exact delegated inputs including the pinned definition. That fingerprint alone is not proof that a test ran.

## Delegate through the existing catalog

`Check.flow` and `Change.implementation` name the host's registered project flows, which perform the native JJ and build operations. Plans pin `flowDigest` and `implementationDigest` from the registry's `Descriptor.executionDigest` before execution; the catalog refuses a changed definition, and replanning starts a new execution. The catalog adapter derives child execution identity from the full payload and the verified executable digest, and refuses unavailable or unverified project flows.
