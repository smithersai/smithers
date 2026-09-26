---
title: "@smthrs/organization"
description: "Agent organizations on Smithers: role profiles and grants, roster validation, composed role prompts, pinned skill packs, hiring lifecycle, and weekly meeting planning."
---

`@smthrs/organization` describes a small organization of agents as files and
answers every authority question about it without a model in the loop. A
principal's profile names its manager, its model seat, its charter, and every
grant it holds. The package loads those files, validates the whole roster
against the organization invariants, composes each role's prompt from pinned
parts, and decides whether a principal may read, write, hire, or contact the
owner.

Apart from the gate steps a host runs, the modules are pure or
filesystem-only. No module here starts a model, a provider connection, or a
virtual machine.

## Modules

| Module      | What it decides                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `Profile`   | The profile, task contract, and role result schemas.                                                    |
| `Grants`    | Whether a child's grants stay inside its parent's, and whether a principal may read, write, or contact. |
| `Roster`    | Loads and renders profile files, validates the organization invariants, and resolves active principals. |
| `Prompt`    | Composes one role invocation from capped, pinned parts with context fenced as data.                     |
| `Skills`    | Loads a licensed, pinned skill pack and selects a role's skills from it.                                |
| `Hiring`    | Proposes hires, runs the lifecycle state machine, and stores hired profiles with compare-and-set.       |
| `Meetings`  | Plans weekly one-on-ones in a time zone and finds free slots, refusing daylight-saving gaps.            |
| `Config`    | Parses the organization, gate policy, connections, and meetings pages.                                  |
| `Gates`     | Attaches Approval and Review gates at flow boundaries; an empty policy adds no node.                    |
| `GatesLive` | The subject binding, decision step, and reviewer a host provides for `Gates`.                           |

## Layout of an organization directory

```text
Org/
  Organization.md           owner, assistant, page locations, seats, VM defaults
  Policy/Gates.md           the gate policy
  Connections.md            provider connections by reference name
  Meetings.md               weekly one-on-one inputs
  Roles/<id>.md             core roles, authored by people
  Specialists/<id>.md       hired principals, written by the roster store
  Skills/<name>/SKILL.md    the pinned skill pack
  Cases/<name>.md           evaluation cases the roles reference
```

The package ships a complete four-role example in
[`example/Org`](../example/Org/): `assistant`, `lead`, `builder`, and
`checker`.

## Next

- [Quickstart](./quickstart.md): load the example and compose a prompt.
- [Concepts](./concepts/organization.md): principals, invariants, lifecycle,
  prompts, and meetings.
- [API reference](./api.md): every export.
