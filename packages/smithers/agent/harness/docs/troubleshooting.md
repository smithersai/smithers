---
title: "Troubleshooting"
description: "The failure modes @smthrs/harness raises, organized by where they surface: realm and sandbox errors, cell rejections, flow-call failures, run-level failures, and structured-output failures."
---

Every failure this package raises is typed and coded, so the first move is to
read the code rather than the message. This page groups the codes by where
they surface and says what causes each and what to do.

## The realm cannot open

**`SandboxError` with code `unsupported`: "This sandbox has no persistent
realm, so it cannot run a cell loop; select the QuickJS binding."** The
composed `Sandbox` binding offers no `openRealm`. This is
`Sandbox.realmUnsupported`, and the controller fails the run at its open with
a `HarnessError` of code `engine_failed`. The fix is to provide a binding that
offers a realm; the shipped one is `QuickJSSandbox.layer`. `Sandbox.makeNoop`
exists for tests and offers none.

**`SandboxError` with code `runtime_failed`: "QuickJS WebAssembly module could
not be loaded."** The QuickJS module failed to load. On Cloudflare workerd the
cause is the runtime's refusal of `WebAssembly.compile` over bytes: the host
named no build, and the fix is the variant wiring in
[Run on Cloudflare workerd](./guides/workerd.md).

**`SandboxError` with code `unsupported`: "The `<name>` limit must be ..."**
A caller-supplied limit failed validation. `calls`, `totalMs`, and `callMs`
must be non-negative safe integers; `steps` and `timeMs` must be safe integers
of at least `Sandbox.minimumSteps` and `Sandbox.minimumTimeMs`;
`memoryBytes` must be a safe integer of at least
`Sandbox.minimumMemoryBytes` (1 MiB). A zero budget would interrupt the
binding's own scaffolding rather than the cell, so the boundary refuses it.

The third `SandboxErrorCode` is `unavailable`, for a binding that cannot
answer at all.

## The cell is rejected

A rejection means the cell never produced a transition. The outcome is
`Cell.Rejected` with a `Cell.RejectionCode`; the model is told, and the run
continues unless the frame budget says otherwise.

| Code                   | Cause                                                                                                                                       | What to do                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_cell`              | `Cell.extract` found no fenced `cell` block in the model's reply.                                                                           | The next request restates the contract; a host driving `Cell.extract` itself teaches the fenced-block shape.                                |
| `output_truncated`     | The reply ends inside an open fence, or the provider stopped on `length`. No block ran.                                                     | The model is told to emit the complete program with every fence closed; raise the provider's output limit if it keeps stopping on `length`. |
| `imports_forbidden`    | `Sandbox.compile` found module syntax in the cell.                                                                                          | Cells have no module loader; a quoted import inside a string is data and runs.                                                              |
| `compile_failed`       | The cell does not parse. The message names the line and column and quotes the offending line.                                               | The controller answers in-frame up to the `revalidations` budget; check `CellProduced.blocks` when a multi-block reply redeclares a name.   |
| `invalid_transition`   | The cell produced something that is not a transition. The message carries the decoder's own report.                                         | A cell states intent by calling `ctx.done` or `ctx.park`, never by returning.                                                               |
| `unsupported_language` | A binding could not compile the cell's language.                                                                                            | Neither shipped binding raises it; cells are JavaScript or erasable TypeScript.                                                             |
| `limit_exceeded`       | The cell spent a ceiling: `calls`, `steps`, `timeMs`, `totalMs`, or heap. A result refused before materialization carries `reason: "heap"`. | Raise the specific ceiling, narrow the cell's work, or request less output; see [limits](./api.md#limits).                                  |
| `stalled`              | "The cell awaited something that never settles."                                                                                            | Inside a cell the only thing worth awaiting is `ctx.call`; find the awaited promise that nothing settles.                                   |

**A frame is refused before it runs, naming names to free.** The realm opened
over its `memoryBytes` run budget, weighed by the panel probe at the previous
frame's close. The refusal names what the realm's own names hold; freeing is
itself done by a cell, so the next cell must drop or slim the named bindings.

**`raised` instead of `settled`.** The cell threw. The outcome carries the
thrown value projected into stable `name` and `message` text, and every name
the cell had already assigned keeps its value, so the next cell carries on
from there.

## A flow call fails

A failed call resolves; it does not throw. The cell reads `{ ok: false,
error: { code, message, hint } }`, where `hint` is
`Cell.callFailureHint[code]`, the one move that recovers the class. The codes,
from `Cell.CallFailureCode`:

| Code                     | Raised when                                                                                                   | Recovery hint                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `unknown_flow`           | The name is not in the registry.                                                                              | Read `ctx.flows` and call one of the names it lists.                                                    |
| `capability_refused`     | The descriptor is not model-invocable.                                                                        | Do the work with a flow `ctx.flows` lists.                                                              |
| `truncated_write`        | A write carries bytes a call already reported as truncated.                                                   | Restore from source control instead of writing captured output.                                         |
| `declaration_changed`    | The registry entry moved after the catalog was shown.                                                         | Read `ctx.flows` again and reissue the call with the shape it now declares.                             |
| `invalid_input`          | The input failed the flow's declared schema, including a non-handle `at`.                                     | Fix the input against the schema in `ctx.flows` and call again in this cell.                            |
| `unimplemented`          | The flow is discovered but the host binds no implementation, or it is a markdown flow and the host runs none. | Choose another flow from `ctx.flows`.                                                                   |
| `timeout`                | The call overran the `callMs` ceiling.                                                                        | Narrow the call, a smaller root, a tighter pattern, a shorter command, and issue it again in this cell. |
| `run_completed`          | The cell already called `ctx.done` or `ctx.park` on an earlier line.                                          | Guard the `ctx.done` or `ctx.park` on the check that decides it.                                        |
| `checkpoint_unavailable` | The host pins no tree, including no `ctx.base` record.                                                        | Drop `at` and take the reading on the live tree.                                                        |
| `checkpoint_exhausted`   | The run reached its `checkpointCap`.                                                                          | Reuse a checkpoint the run already holds, or `ctx.base`.                                                |
| `checkpoint_readonly`    | A flow that writes ran against a checkpoint.                                                                  | Drop `at` and make the change on the live tree.                                                         |
| `checkpoint_unsupported` | The flow names what it touches rather than where it runs, so it cannot be pointed at a checkpoint.            | Drop `at`, or run the work through a shell flow, which takes a working directory.                       |
| `flow_failed`            | The flow itself failed; the default when nothing classified the failure.                                      | Read `error.message`: the flow says what went wrong, and it is usually fixable in the same cell.        |

**The same interrupted call runs twice.** A call the `callMs` ceiling
interrupted settled nowhere, so a re-executed frame issues it to the host
again and is then handed the recorded timeout. The cell's branch is stable
either way; what the run pays for twice is the interrupted call. See
[durability](./api.md#durability).

## The run fails or stops

The controller's own failures are `HarnessError`s, with
`HarnessError.HarnessErrorCode`:

| Code                   | Meaning                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `assembly_failed`      | Composition refused something: two bindings under one name, or an unnamed binding.                                                           |
| `incompatible_journal` | The journal predates the current harness journal format, or a resumed frame is missing a record it needs. Start a new run; no repair exists. |
| `render_failed`        | A boundary could not render what it had to show.                                                                                             |
| `model_failed`         | The sealed model step failed.                                                                                                                |
| `engine_failed`        | The engine boundary failed, including a realm that could not open.                                                                           |
| `read_only_cap`        | The run spent its read-only budget: the cap demanded an edit or a justification, and twice the cap stops the run.                            |
| `suspended`            | The run parked: a permission requirement, a durable wait, or an engine suspension.                                                           |

Interrupting a run raises no `HarnessError`: the stream ends with an
`AgentEvent.Aborted` event and the interrupt cause is forwarded unchanged. A
projection that fails is a `Transcript.TranscriptError` with code
`projection_failed`, not a `HarnessError`.

**A `park` transition comes back refused.** `CellTurn.make` defaults
`approvalChannel` to `false`, which means nobody can answer the run, so a
park is not patience but abandonment: the controller refuses the transition
and answers it in the frame that returned it. Only a host that has wired
somewhere for an answer to come from sets `approvalChannel: true`.

**`ctx.park` rejects its reason.** The reason must be one of
`"waiting-input"`, `"waiting-event"`, or `"waiting-quota"`; anything else is
answered with the message naming the three.

**A composition fails with `assembly_failed`.** Two executable bindings share
one name, or a binding has no name. `FlowBinding.catalogResult` refuses both
because one name must resolve to exactly one implementation; rename one or
drop it before composing.

## Structured output fails

`StructuredOutput.decode` turns one agent answer into a typed value or a
typed `StructuredOutputFailure`. The failure carries the schema digest, the
last candidate's digest, the corrections spent, the budget, and at most
`StructuredOutput.maxIssues` (5) `{ code, path, message }` issues. The codes:

- `invalid_json`: candidate text was not JSON.
- `schema_mismatch`: a parsed candidate failed the declared schema; the
  issues are the decoder's own.
- `no_candidate`: the answer held no JSON document at all.
- `correction_exhausted`: the correction budget is spent, which replaces
  whichever of the three above the last candidate produced. The issue records
  retain the underlying class.

`StructuredOutput.candidates` shows the recovery order the decoder offers:
the complete BOM-stripped response first, then the balanced JSON container
whose matching close ends last. `StructuredOutput.correction` is the teaching
a caller re-prompts with while it still holds a correction slot.
