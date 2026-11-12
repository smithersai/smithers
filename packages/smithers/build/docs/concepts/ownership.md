---
title: "Ownership"
description: "Declaring package owners as inert data, how ownership inherits down a tree, and the CODEOWNERS and OWNERS files generated from it."
---

A package names who owns it the same way it names its targets: as inert data
on the `S.Package` call. The declaration answers three questions the landing
gate, the reviewer picker, and a migration fleet all ask about a changed
file: who must approve it, who should look at it, and what an agent may do
to it without a human.

```ts
// src/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { Package as data } from "../data/PACKAGE.js"

export const Package = S.Package({
  owners: {
    owners: ["dzucconi", "team:web"],
    perFile: { "*.graphql": ["team:data"] },
    agents: { default: "human-approve", "auto-land": ["**/*.md"], deny: ["Server/**"] },
    upstream: "review"
  },
  targets: { ... }
})
```

`PACKAGE.ts` is the only place ownership is written. `.github/CODEOWNERS` and
the per-directory `OWNERS` tree are generated from it by two rules in the
catalog, and checked for drift like every other generated file.

## The declaration

| Key        | Type                                                             | Meaning                                                                                                             |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `owners`   | `Array<string>`                                                  | Logins and `team:<name>` references. Every one is a required approver for every path in the package.                |
| `perFile`  | `Record<glob, string \| Array<string>>`                          | Owners added for paths matching a glob, relative to the package directory. A bare file glob matches at every depth. |
| `noparent` | `boolean`                                                        | Stop inheriting from the parent package. Requires at least one owner here.                                          |
| `agents`   | policy, or `{ default?, "auto-land"?, "human-approve"?, deny? }` | What an agent-authored change may do; see [Agent policy](#agent-policy).                                            |
| `upstream` | `"none" \| "review" \| "approve" \| { mode, packages? }`         | Claim changes to the packages this one depends on; see [Upstream](#upstream).                                       |

Every value is validated when the module evaluates: a login that is not
GitHub-shaped, a pattern that escapes the package, a policy name that is not
one of the three, or a `noparent` with nobody named all fail there, not at
resolution time. `S.Owners.declare(options)` runs the same validation on its
own and returns the frozen declaration the `owners` option would have stored.

The workspace carries two more declarations:

```ts
// .smithers/WORKSPACE.ts
export const Workspace = S.Workspace("force", {
  teams: S.Teams({ web: ["dzucconi", "erikdstock"], data: ["chungyi"] }),
  owners: { owners: ["team:web"], agents: "human-approve" },
  ...
})
```

`teams` is the roster every `team:<name>` reference resolves against. A
reference to a team the roster does not declare fails graph load with
`unknown_team`, the way an `S.Agents.<name>` reference to an undeclared agent
does. Team membership never expands in a resolution or a generated file:
owners stay written as `team:web`, and CODEOWNERS renders them as
`@<org>/web`. `owners` on the workspace are the defaults a path resolves to
when no package in its chain declares any.

## Resolution

A path belongs to the deepest package whose directory contains it. Its owners
are collected in this order, and every owner carries the reasons it is there:

1. **direct**: the owning package's `owners`.
2. **per-file**: every `perFile` rule of the owning package the path matches.
3. **inherited from //pkg**: the parent package's `owners` and matching
   `perFile` rules, then its parent's, up to the root. A package that sets
   `noparent` ends the walk.
4. **workspace**: the workspace `owners`, only when no package in the chain
   declared anything.
5. **upstream-of //pkg**: the owners of every package that claims this one;
   see below.

A package directory without a `PACKAGE.ts` is not a package: a file under it
belongs to the nearest ancestor that has one, and inheritance skips it.

An owner has one of two roles. `approve` means a landing needs their
approval; `review` means they are suggested but not required. Every reason
except an upstream `review` claim gives the `approve` role, and an owner who
is both is `approve`.

## Agent policy

`agents` decides what an agent-authored change may do to a path:

| Policy          | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `auto-land`     | An agent LGTM alone lands it; no human owner needs to approve.     |
| `human-approve` | A human owner must approve. The default when nothing declares one. |
| `deny`          | Agent-authored changes to the path are refused.                    |

The policy for a path is decided by the nearest package in its chain that
declares `agents`: the first override whose glob matches the path (relative to
that package, in the order `auto-land`, `human-approve`, `deny` as written)
wins, else that package's default. `noparent` stops the walk here too, and
the workspace declaration is the last resort.

Policies never merge across packages. The deepest declaring package decides,
so a `deny` on `src/Server/**` in `src/PACKAGE.ts` is not overridden by an
`auto-land` in the root.

## Upstream

A package's **upstream** is the set of packages it depends on, transitively,
through declared dependencies: every package that owns a target reachable
from any of its labeled targets, which is what `deps()` reaches. An app that
lists `lib.srcs` in a build target's `data` has `//lib` upstream.

`upstream` on the app's owners declaration claims changes to those packages:

| Value                                           | Effect on a change inside an upstream package                            |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `"none"` (default)                              | Nothing.                                                                 |
| `"review"`                                      | The app's owners become suggested reviewers, reason `upstream-of //app`. |
| `"approve"`                                     | The app's owners become required approvers, reason `upstream-of //app`.  |
| `{ mode, packages: ["//lib", "//shared/..."] }` | The same, bounded to the named package labels and subtree patterns.      |

"The app's owners" means the app package's own resolved owners: its `owners`,
what it inherits, or the workspace defaults, without its `perFile` rules. A
claim is decided per package, not per file, and never reaches a package the
claimant does not actually depend on: bounding a claim to `//lib/...` does
not make `//lib/inner` claimed unless a target there is a dependency.

Ask the graph directly:

```sh
smithers-build query 'rdeps(//lib:srcs)'   # every labeled target that depends on it
smithers-build query 'owners(//lib:srcs)'  # the owners of the package holding it
```

## The owners command

```sh
smithers-build owners src/Apps/Artwork/index.tsx data/schema.graphql
smithers-build owners --diff origin/main
smithers-build owners --diff HEAD --format json
```

For each path the command prints the owning package, the agent policy, and
every owner with its role and reasons, then the union of required approvers
and suggested reviewers. `--diff <base>` adds every path changed since that
git base, both names of a rename and every untracked file included, so the
package a file leaves keeps its owners and agent policy in the answer.

`--format json` prints the shape the Smithers landing gate reads:

```json
{
  "touched_paths": [
    {
      "path": "data/schema.graphql",
      "package": "//data",
      "owners": [
        { "team": "data", "role": "approve", "reasons": ["direct"] },
        { "login": "dzucconi", "role": "review", "reasons": ["upstream-of //src"] }
      ],
      "agent_policy": "deny",
      "packages": ["//data", "//src"]
    }
  ],
  "required_approvers": ["team:data"],
  "suggested_reviewers": ["dzucconi"]
}
```

The command reads declarations only. It knows nothing about who has
approved; `missing_approvals` is computed by the server that holds the
reviews.

## Generated files

Two catalog rules project the declarations, both check-by-default:

```ts
// PACKAGE.ts at the root
export const Package = S.Package({
  targets: {
    codeowners: S.Owners.Codeowners({ org: "artsy" }),
    ownersTree: S.Owners.Tree({})
  }
})
```

```sh
smithers-build lint //:codeowners //:ownersTree   # drift is red
smithers-build //:codeowners --write              # apply
smithers-build //:ownersTree --write
```

[Owners.Codeowners](../reference/targets/owners-codeowners.md) writes
`.github/CODEOWNERS` with GitHub semantics: least specific line first, so the
last matching line, the deepest package or per-file rule, wins. Only required
approvers appear, and an `upstream: "approve"` claim adds the claimant's
owners to the claimed package's line. A `review` claim has no CODEOWNERS
form. The workspace defaults supply the root `*` line and root `OWNERS`
even when the workspace has no root `PACKAGE.ts`, covering root files and
unpackaged directories.

[Owners.Tree](../reference/targets/owners-tree.md) writes one `OWNERS` file per
package that declares ownership, in the format the Smithers landing gate
parses: `set noparent`, one owner per line, `per-file <glob> = <owners>`,
`agents: <policy>` and `agents: <policy> <glob>` per override, and
`reviewers: <owners>` for upstream review claims. Both files carry a header
naming `PACKAGE.ts` as the source; edit the declaration and regenerate.

## Next

- [Owners.Codeowners](../reference/targets/owners-codeowners.md)
- [Owners.Tree](../reference/targets/owners-tree.md)
- [Querying](../workspace/querying.md)
- [Dependencies](dependencies.md)
