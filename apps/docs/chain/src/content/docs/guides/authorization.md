---
title: "Authorize calls"
description: "Mount gate 4: per-call authorization against the capabilities an entry declares, with rules, verdicts, and approval parking."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/guides/authorization.md"
---

Gate 4 is optional: a chain without the `Authorize` service runs every call.
Mount it to decide each call against the capabilities its entry declares. The
check runs outside the journal on purpose: a permission requirement must be
re-decidable against a later grant, so a parked chain re-asks on resume
instead of replaying a refusal forever.

## Declare capabilities on entries

An entry's `capabilities` are `action:resource` strings, the only policy
input the seam receives:

```ts
const write: Catalog.Entry = {
  name: "repo/write",
  description: "Write one file in the repository",
  capabilities: ["fs:write:src/**"],
  handler: () => Effect.succeed("written")
}
```

Undeclared entries claim `["*"]`, the broadest claim: they ask under rules,
never silently pass. An explicit empty array claims no external authority and
skips the seam entirely; the `sys/now` and `sys/random` system entries
declare one for exactly that reason.

## Mount the rules seam

`Authorize.layerRules` decides claims through
[@smthrs/capability](https://capability.smithers.sh/reference/api/) rules:

```ts
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Authorize } from "@smthrs/chain"

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })

const authorize = Authorize.layerRules([
  new Rule({ effect: "allow", pattern: pattern("model:call", "**") }),
  new Rule({ effect: "allow", pattern: pattern("fs:read", "**") }),
  new Rule({ effect: "deny", pattern: pattern("fs:write", "/etc/*") })
])
```

A claim that names one exact capability is decided by `Permission.evaluate`,
so a host reusing its kernel ruleset gets the same verdict from both engines.
A claim that names a SET (a family action such as `fs:*`, or a resource glob)
is decided pattern-to-pattern: a rule that subsumes the whole set is
last-match-wins, while a `deny` or `ask` that may cover only part of the set
can only raise the verdict, never lower a restriction that still governs
another member. Across one request's claims, `deny` beats `ask` beats
`allow`. An unmatched or unparseable claim asks: the conservative posture.
Claim parsing extends the capability grammar in one direction only: a
two-component claim with no resource (`fs:read`) claims the whole family, as
if it ended in `:**`.

## What the verdicts do to a run

- `allow`: the call proceeds. Nothing extra is journaled.
- `deny`: for a catalog call, the chain journals a `denied` observation the
  next author routes around. For the author seat itself, the error
  propagates typed: routing around a denied model seat by authoring again
  would burn tokens on a chain that cannot author.
- `ask`: the seam fails with `approval_required` and the run returns
  `ApprovalWait` without a `LinkEnded`. Resuming re-executes the link from its settled
  prefix and re-asks the seam under whatever grant now exists.
- Seam unreachable: `authorize_unavailable` always propagates to the
  caller, for catalog calls and the model seat alike.

## Cover the author seat

The model call is inside the policy too: the chain evaluates it against the
claim `model:call:author` (exported as `Chain.authorCapability`) like any
other effect. A ruleset that does not cover it answers `ask`, and the chain
parks before its first author call. The `allow model:call **` rule in the
example above covers it; `Authorize.layerAllowAll` admits everything for
hosts that enforce elsewhere.

For sub-agent spawning authority (`proc:spawn:agent`), see
[Run sub-agents](/guides/sub-chains/). For the parking and resume mechanics, see
[Resume and replay](/guides/resume-and-replay/).
