# Agents are flow callers

`@smthrs/agent` runs a coding agent as a durable program. Each turn the model writes a JavaScript cell that runs in a QuickJS sandbox. A cell's only authority is `ctx.call(flowName, input)`, so reading a file or running a command is a flow call that the engine keys, journals and can replay.

## Use a typed model action

`AgentAction.make` declares a model-backed step with a payload, an output schema, a seat, system text and a prompt. `.call` records the same plan node as any other action, and `.layer` is its implementation. The step answers with a value decoded by the output schema, so later steps read typed fields.

`AgentAction` runs the agent loop as one typed step inside a larger flow. `AgentSession` runs it as one whole durable run that an operator steers and approves.

## Seats are resolved by the host

A seat string names a model without carrying a credential. Resolving it into a live model is the host's job.

## The wiki reviewer is an ordinary agent action

`ReviewPage` in `flows/wiki/workflow.ts` is an `AgentAction` on the `wiki/reviewer` seat whose output is a `Review`. Its system text says it has no tools or authority to edit files and that a current-behavior section must cite a file other than its own page. Its host supplies an empty descriptor registry, an empty capability envelope and at most 8 frames.

A review that fails exact validation gets one correction call; a second failure is terminal. Surviving reviews then pass `CheckCitations`, which judges whether each cited line supports its claim.
