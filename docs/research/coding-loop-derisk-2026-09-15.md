# Coding-loop derisk — engineering findings, 2026-09-15

This historical investigation exercised `coding/request` through its gateway.
The public record retains reusable findings and a generic protocol example.
Account observations, workspace identities, hosted remediation and live-run
receipts are retained in private operations records.

## Result and limits

Implementation can create a native jj Change, run repository checks against an
exported immutable tree and enter a correction round. A failed required check
must leave the result `blocked`; producing a Change is not a successful landing.
These conclusions do not certify any current deployment or provider account.

## Engineering findings

### Bootstrap verification depends on runtime readiness

A helper's smoke test can fail before a required runtime dependency is ready,
even though the same helper works after activation. Verify helpers in the
environment that will execute them, distinguish missing dependencies from a
bad artifact and test the full bootstrap lifecycle.

### Flow registration and landing must agree

A flow that delegates landing needs compatible endpoint contracts and explicit
host configuration. Test registration and the complete landing protocol
together. Successful implementation and checks alone do not prove delivery.

### Projection limits need a visible failure state

The historical gateway refused a projection when event history exceeded
`maxProjectionBytes` in `packages/smithers/gateway/src/Projections.ts`:

```text
GatewayError resource_limit: Run event history exceeds 4194304 encoded bytes
```

A resource refusal is not a truncated successful projection. Test the boundary
and ensure the run's failure remains visible to the client.

### Durable retries must respect provider error classification

A model refusal classified as `ModelError.retryable = false`, such as
`quota_exceeded`, must retain that classification through the enclosing flow.
Repeatedly retrying a permanent refusal cannot repair it. Regression coverage
should distinguish transient provider errors from permanent refusals without
depending on a real account's quota or credit balance.

### Required checks remain authoritative

A model can produce plausible prose that fails an explicit repository check,
even when its prompt includes the required words. Retain the failing check
message through correction and report `blocked` if the correction still fails.
Model output alone is not evidence that the requested change passed.

## Reproducing

Use a disposable repository and a compatible gateway. The following illustrates
the protocol shape; `repo`, `workspaceId`, `prompt` and the plan fields come from
that fixture, not from a hosted operations record.

```text
POST /api/workflow/provision  {repo, workspaceId}
POST /api/workflow/rpc        {repo, workspaceId, procedure: "Plan",
                               payload: {flowId: "coding/request",
                                         input: {prompt, maxRounds}}}
POST /api/workflow/rpc        ... "Approval.Submit"
                               {target: {_tag: "Plan", planId, digest, envelope},
                                scope: "run", idempotencyKey, decision: "approve"}
POST /api/workflow/rpc        ... "Run"
                               {_tag: "Plan", planId, digest, envelope, idempotencyKey}
```

Answer a parked planner question using its `approvals` projection row and
`{...row.payload, decision: "approve", answer}` sent to `Approval.Submit`.
Retain the source and check results for each attempt; never infer a landing
from a launch acknowledgment.
