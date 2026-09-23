---
title: "Namespace execution ids per tenant"
description: "Use the ExecutionIdScope hook on either FlowProxyServer layer to rewrite the caller-supplied execution id in one server-owned place, so two tenants that submit the same id do not share a run."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/guides/namespace-execution-ids.md"
---

Execution ids come from clients, so a server that accepts requests from more
than one principal has a problem: two tenants that both submit `report-1` are
one execution. `ExecutionIdScope` is the one place to fix it.

## The hook

Pass an `executionId` function to either server layer. The server calls it once
inside each execute, discard, and resume handler:

```ts
import { FlowProxyServer } from "@smthrs/engine"
import { Action, Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const ReportStep = Action.make("docs/ReportStep", {
  payload: { id: Schema.String },
  success: Schema.String
})

const Report = Flow.make("docs/Report", {
  payload: { id: Schema.String },
  success: Schema.String,
  body: (payload) => ReportStep.call(payload)
})

const flows = [Report] as const

const handlersFor = (tenant: string) =>
  FlowProxyServer.layerRpcHandlers(flows, {
    executionId: ({ clientValue }) => clientValue === undefined ? undefined : `${tenant}/${clientValue}`
  })
```

`layerHttpApi` takes the same option in the same position of its options
object, and applies it to the same three operations. Resume is included on
purpose: a mapping that skipped it would let a client resume across the
namespace it was confined to.

## What the hook receives, and what returning undefined means

The input names the flow, the operation, the client's value, and the request
payload:

| Field         | Value                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `flow`        | The flow declaration this request addresses.                                                                |
| `operation`   | `"execute"`, `"discard"`, or `"resume"`.                                                                    |
| `clientValue` | The execution id the client sent, or `undefined`.                                                           |
| `payload`     | The decoded flow payload for execute and discard. `undefined` for resume, whose request carries only an id. |

Returning `undefined` means two different things:

- For execute and discard, it selects the flow's idempotency key or ambient
  execution-id source. Without a key or a custom source, each call gets a fresh
  UUID and does not reattach to earlier work.
- For resume, it is a refusal. The server raises `Flow.ExecutionIdRequired`
  as a defect and never calls `Flow.resume`. Substituting the client's value there
  would hand the engine the very id the hook exists to replace, which is how a
  client resumes across the namespace it was confined to.

So a scope must return a string for every resume. Without the option, every
client value passes through unchanged.

## Constraints on the implementation

The hook is a pure function over the flow and the request payload. It must
return for every input, and a string for every resume.

It receives no request-scoped service, so it cannot read the caller's
authentication by itself. That is deliberate: the identity it namespaces by has
to be trusted, and a hook reaching into request context would make it easy to
namespace by a value the client supplied. Build the layer where the tenant is
already known, so the function closes over a trusted value, as `handlersFor`
does above.

Middleware that authenticates a request can also put the tenant in the flow
payload, and a scope may read it from `payload` for execute and discard. A
resume request carries no payload, so a scope written that way has no tenant on
resume: pair it with a closure over the same trusted namespace, or every resume
is refused.

## Related

- [Execution identity](/concepts/execution-identity/): why a shared id is a
  shared run, and which reuses the engine refuses outright.
- [Serve flows over RPC or HTTP](/guides/serve-flows/): the layers this option
  belongs to.
