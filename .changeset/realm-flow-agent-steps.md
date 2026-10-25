---
"@smthrs/harness": minor
---

`RealmFlow` runs agent steps and names its refusals.

- The realm provides `AgentAction` from `@smthrs/agent`. `AgentAction.make(tag,
  { payload, output, seat, prompt })` renders its prompt inside the realm when
  the step dispatches and crosses as a request for the host action
  `RealmFlow.agentAction` with `RealmFlow.AgentPayload` (`{ step, seat, prompt }`).
  A host offers agent steps by listing `RealmFlow.agentAction` in
  `allowedActions`; the receipt's success value is the agent's answer.
- `RealmFlowError` adds `forbidden_import` (a module the realm doesn't provide,
  even when the module catches the error) and `action_not_allowed` (an action
  or agent step the host didn't list, in a branch never taken too). Both were
  `execution_failed` before.
- Raw callbacks work: the realm interprets with process-local callback
  identity, which is reproducible in a fresh realm with a fixed nonce, so a flow
  body need not be wrapped in `Node.capture`.

`RealmFlow.version` changes with the bundle; a host that pins it refuses to
recover runs started under the previous version.
