---
title: "Give a run capabilities"
description: "Bind the standard capability flows (filesystem, shell, tests, memory, durable wait, approval, classify), order them with plugin contributions, and gate calls with authorize."
sidebar:
  order: 5
---

Every capability a cell reaches is an ordinary flow. There is no `ctx.fs`, no
`ctx.shell`, no `ctx.memory`, and no `ctx.wait`: a cell finds a flow in
`ctx.flows` and invokes it with `ctx.call`, and the boundary is the same keyed,
journaled, permission-gated activity whether the flow reads a file or calls a
remote tool. This guide covers binding the built-ins and adding your own.

## Bind the standard flows

`StandardFlows` pairs declarations that already exist with the handlers that
already exist. Each helper takes the slice of host services its handlers
require, so two capabilities built from two different slices of the host
compose into one `flows` array:

```ts
import { ChildFlows, StandardFlows } from "@smthrs/agent"

const run = agent.run({
  // session, seat, prompt, registry ...
  flows: [
    StandardFlows.filesystem(filesystemServices), // FileSystem | Path
    StandardFlows.shell(shellServices), // ChildProcessSpawner | Path
    StandardFlows.tests(testServices), // ChildProcessSpawner | Evaluator | TestRunner
    StandardFlows.memory(memoryServices), // MemoryStore | Recall
    StandardFlows.classify(evaluatorServices), // Evaluator
    ChildFlows.source(children)
  ]
})
```

| Helper       | Flows bound                                                                             | Context it takes                                 |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `filesystem` | `read`, `write`, `edit`, `apply_patch`, `ls`, `glob`, `grep`                            | `FileSystem \| Path`                             |
| `shell`      | `bash`                                                                                  | `ChildProcessSpawner \| Path`                    |
| `tests`      | the project's test runner                                                               | `ChildProcessSpawner \| Evaluator \| TestRunner` |
| `memory`     | `remember`, `recall`                                                                    | `MemoryStore \| Recall`                          |
| `clock`      | `wait`                                                                                  | `Crypto \| FlowRuntime \| FlowInstance`          |
| `approval`   | `ask`                                                                                   | an `Asker` port, not a context                   |
| `classify`   | `classify`, `classify/triage/relevance`, `classify/check/verdict`, `classify/edit/risk` | `Evaluator`                                      |

All seven filesystem flows are bound, not just `read` and `write`: a host that
offers whole-file writes and nothing else forces every edit through "read the
file, then write the whole file back". `shell` takes an optional container
transport, defaulting to the docker or podman CLI, which is what makes `bash`'s
`container` field mean anything. `clock` is the one helper whose context is the
durable engine; nothing in `Agent` imports it, and `AgentSession` composes it
for you.

## Approval needs a human

`approval` takes a narrow injected `Asker` port rather than a fake: one `ask`
method. A host with nobody to ask binds `StandardFlows.askerNoop()`, which
refuses with `ApprovalUnavailable`, a refusal the cell may catch and route
around. A host that wants the run to wait for a person does not answer at all:
it fails with a `HarnessError` carrying a `Permission.PermissionRequired`, or
gates the call in `Agent.Options.authorize`, so the park stays in the typed
error channel where the cell can neither see nor swallow it. `AgentSession`
wires its `ask` through the control plane this way; see
[Run the agent as a control-plane run](./control-plane-runs.md#the-approval-gate).

## Jev needs a transport

**`AI_GATEWAY_API_KEY` is required to run an agent.** The harness's sixth
brake on a completion asks Jev whether the claim the run wrote matches the
evidence the run produced, and it never falls back: a completion nothing
could judge fails the run as `HarnessError` `completion_unjudged` carrying the
reason. `Agent.run` and every `AgentAction` layer therefore require
`Evaluator.Evaluator`, so a composition that binds none does not compile.
Bind `Evaluator.layerFromEnvironment(process.env)`; without the key that is
`Evaluator.layerUnavailable()` and every run fails at its first completion, by
design. See [the harness's completion brake](https://harness.smithers.sh/reference/api/#completionclaim).

The same service answers the cell's own classify doors, which fail softly
instead:

`classify` binds the cell's doors to Jev: the ad-hoc `classify` flow, which
takes any JSON state and model-authored questions, and one `classify/<id>` flow
per curated classifier, which takes the classifier's own state. The one service
is the `Evaluator` from [`@smthrs/model`](/api/model). A host with a Vercel AI
Gateway key binds `Evaluator.layerVercelGateway({ apiKey })`; a host without
one binds `Evaluator.layerUnavailable()`, and every classify call then resolves
in the cell as `{ ok: false, error: { code: "flow_failed", message } }` with a
message containing `unreachable:` after the binding's `Flow <name> failed:`
prefix, so the cell carries on instead of hanging. Grant `model:call:*` in the
capability envelope beside `fs:read:/**` and the rest, or the boundary refuses
the call before it reaches the transport. Pass `{ classifiers: [] }` to offer
the ad-hoc door alone, or your own `Classifier.make` declarations to add doors
the catalog describes by name.

## How the catalog is composed

`flows` is an ordered list of `FlowBinding.Source`s. Plugin `cellFlows`
handlers run after them, in resolution order, and the composed catalog is both
what the model is shown and what the boundary resolves against: the declaration
digest a cell was written against is the one checked when the call arrives.
Duplicate names fail composition rather than dispatching one descriptor to
another implementation.

The catalog shown to the model is the registry's `visible()` narrowed to
model-invocable flows, so a discovered markdown flow in the registry is already
callable without a binding; `flows` is for capabilities that need a host
implementation.

## Contribute capabilities from a plugin

`CellPlugin.fromBindings` is the one-liner for a plugin that adds executable
flows:

```ts
import { CellPlugin } from "@smthrs/agent"

const deployPlugin = CellPlugin.fromBindings({
  name: "deploy",
  bindings: [/* FlowBinding.make({ flow, handler }) entries */]
})
```

The whole plugin is `name` plus bindings; ordering, `apply` filtering, and the
config waterfall are the plugin kernel's. A plugin that needs to transform
other plugins' flows writes the `cellFlows` hook itself. For the binding
contract, see [`@smthrs/harness`](/api/harness); for the kernel, see
[`@smthrs/plugin`](/api/plugin).

## Gate calls with authorize

`Agent.Options.authorize` decides whether a call may proceed, and it runs
before the call's durable boundary opens. That placement is the point: an
activity's outcome is journaled, so a permission requirement raised from inside
one would replay forever and no later grant could unblock it. Checked outside,
a park records nothing, and the resumed attempt asks again against the grant
store as it now stands.

## Declare the envelope honestly

`Agent.Options.capabilityEnvelope` is the composition's complete authority, and
the default really is "nothing granted". It matters beyond gating: a sealed
boundary is cross-run cacheable, so a result computed under a broad envelope
must not be served to a run with an attenuated one. The envelope is folded into
the run's content environment; `Agent.run` declares the envelope it actually
built, so hosts on that path get cross-run reuse without asserting anything
false. The key rules are in [The engine port](../concepts/engine-port.md).
