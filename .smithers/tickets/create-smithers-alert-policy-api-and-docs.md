# User-facing alert policy API in createSmithers and workflow docs

## Problem

Smithers has no first-class user-facing API for configuring observability and alert
policy at workflow definition time.

Today:

- `createSmithers(..., opts)` only supports DB concerns like `dbPath` and
  `journalMode`
- `SmithersWorkflowOptions` only exposes `cache` and `workflowHash`
- users can manually build alert-like logic inside workflows with components such as
  `DriftDetector`, but there is no standard declarative way to say:
  - what should alert
  - how severe it is
  - who owns it
  - how Smithers should react
  - where the runbook lives

That means users who want production-grade alert behavior have to invent their own
contract from scratch, and the docs do not show a recommended path.

## Proposal

Add a user-facing observability / alert policy API to the authoring surface, and
document it clearly.

### API shape

Split configuration into:

- `createSmithers(..., opts)` for defaults shared by the workflow module
- `smithers(build, opts)` for workflow-specific overrides

Proposed direction:

```ts
const { Workflow, smithers, outputs } = createSmithers(
  {
    input: inputSchema,
    result: resultSchema,
  },
  {
    dbPath: "./smithers.db",
    observability: {
      alerts: {
        defaults: {
          owner: "platform",
          severity: "warning",
          runbook: "https://internal/runbooks/smithers-workflows",
          labels: { service: "deploy-bot", env: "prod" },
        },
      },
    },
  },
);

export default smithers(
  (ctx) => (
    <Workflow name="deploy">
      {/* ... */}
    </Workflow>
  ),
  {
    observability: {
      alerts: {
        rules: {
          runFailed: { severity: "critical", reaction: "notify-oncall" },
          approvalWaitExceeded: {
            afterMs: 86_400_000,
            severity: "warning",
            reaction: "notify-author",
          },
          tokenBudgetExceeded: {
            severity: "warning",
            reaction: "pause-run",
          },
        },
        reactions: {
          "pause-run": { kind: "pause" },
          "notify-oncall": { kind: "deliver", destination: "oncall" },
          "notify-author": { kind: "deliver", destination: "author" },
        },
      },
    },
  },
);
```

### Reaction model

The runtime should support a small set of deterministic reactions:

- `emit-only`
- `pause`
- `cancel`
- `open-approval`
- `deliver`

`deliver` should route through an explicit notifier boundary, not a built-in Slack /
PagerDuty client.

### Delivery boundary

Add a runtime service such as `SmithersAlertNotifier`:

- the alert policy chooses **what** should happen
- the notifier service decides **how** to send it

That preserves the existing Smithers rule:

- Smithers owns durable state and policy
- external systems own transport

### Documentation

Document:

- how to enable platform alerts
- how to declare workflow alert rules
- how to configure severity / owner / runbook / labels
- how to bind a notifier service
- how to choose reactions safely
- how workflow alerts differ from manual business-logic notifications

## Rollout phases

### Phase 1: Types and API design

- Extend `createSmithers()` opts and workflow opts with an `observability` block.
- Add typed alert policy schema and reaction types.
- Define precedence rules between module defaults and workflow overrides.

### Phase 2: Runtime integration

- Connect the policy model to durable alert evaluation and notifier delivery.
- Fail clearly when a policy references a missing destination or unsupported
  reaction.

### Phase 3: Docs and examples

- Add a dedicated alerts guide.
- Add `createSmithers()` examples for local, staging, and production profiles.
- Update monitoring docs to point to the new recommended API.

## Additional steps

1. Keep the API small and typed; do not expose an unbounded callback escape hatch
   inside the core engine.
2. Let `createSmithers()` define defaults and `smithers()` override them when a
   module exports multiple workflows.
3. Add good defaults so users can start with minimal config and grow into advanced
   policies.
4. Support runbook URLs, ownership, and labels from day one.
5. Document anti-patterns:
   - using alert policy for every ordinary product notification
   - shipping secrets directly in workflow code
   - using unbounded dynamic labels

## Verification requirements

### Type and API tests

1. **Typed config** - Invalid severities, reactions, or destination references fail
   at compile time or validation time.
2. **Precedence** - Workflow-level alert config overrides module defaults
   predictably.
3. **Backward compatibility** - Existing `createSmithers()` calls without
   observability config continue to work unchanged.
4. **Missing destination** - Referencing an unknown delivery destination fails with
   a clear error.

### Runtime tests

5. **Pause reaction** - A configured alert can pause a run deterministically.
6. **Open approval reaction** - A configured alert can create a human acknowledgment
   gate.
7. **Deliver reaction** - A configured alert invokes the notifier boundary with the
   expected alert payload.
8. **Emit-only reaction** - A configured alert emits durable records without
   external delivery.

### Documentation tests

9. **Docs examples typecheck** - All new `createSmithers()` alert examples compile.
10. **Docs parity** - Monitoring docs and alert docs agree on the recommended
    integration model.

## Observability

### New events

This ticket depends on the durable alert lifecycle work and should reuse:

- `AlertFired`
- `AlertAcknowledged`
- `AlertResolved`
- `AlertSilenced`

### Logging

- Log resolved policy configuration at startup at debug level
- Log destination resolution and delivery attempts with alert correlation context

## Codebase context

### Authoring API

- `src/create.ts`
- `src/SmithersWorkflowOptions.ts`
- `src/index.ts`

### Current related components and docs

- `src/components/DriftDetector.ts`
- `docs/components/drift-detector.mdx`
- `docs/guides/monitoring-logs.mdx`
- `docs/introduction.mdx`
- `docs/jsx/overview.mdx`
- `docs/api/overview.mdx`

### Adjacent work

- `.smithers/tickets/workflow-alerting-and-durable-alert-instances.md`

## Effect.ts architecture

Policy evaluation and alert delivery orchestration should remain in Effect-native
services.

- Do not encourage users to pass arbitrary fire-and-forget JS callbacks into
  `createSmithers()`.
- Keep transport integrations at an explicit boundary service.
- Preserve durability and replay semantics even when alert delivery fails.
