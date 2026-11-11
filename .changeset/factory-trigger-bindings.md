---
"@smthrs/triggers": minor
"@smthrs/targets": minor
---

A repository binds its flows to events in `.smithers/FACTORY.ts`: `S.Factory({ triggers: { "gate-push": Trigger.bind({ flow: Gate, on: On.push({ branches: ["main"] }) }) } })`. `@smthrs/triggers` gains `Trigger.bind`, `Trigger.manifestRow` and the `On` module (`push`, `pullRequest`, `manual`, `cron`). The factory projection writes the bindings into `.smithers/factory.json` as plugin manifest rows under `apiVersion: 1` and `contributes.triggers`, the rows the hosted app matches a push or a pull request against, and refuses a binding whose flow is no `flow.ts` one directory under the flows root. A factory that binds nothing projects as before.
