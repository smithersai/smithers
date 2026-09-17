---
title: "Effects and capabilities"
description: "What each flow declares before it runs, how effectsFor narrows that declaration to one call, and why hermetic mode is a lexical pre-check rather than a sandbox."
sidebar:
  order: 2
---

Every declaration carries two statements about what running it would do: an
**effect envelope** and a list of **capabilities**. A scheduler reads the first
to decide what may run beside what. A permission kernel reads the second to
decide whether it may run at all.

## The envelope

An envelope has four parts:

- `tier` is how reversible the effect is: `sealed` (observes only),
  `compensable` (can be undone), or `irreversible` (cannot).
- `mode` is `hermetic` when the flow declares the paths it touches, and
  `expected` when it does not.
- `reads` and `writes` are path globs.
- `onConflict` is `serialize` for every flow in this package. The library owns
  no lane partitioning of its own, so the conservative choice is the safe one.

Here is what each flow declares at registry time, before any input is known:

| Flow            | Tier           | Mode       | Declared reads and writes | Capabilities                  |
| --------------- | -------------- | ---------- | ------------------------- | ----------------------------- |
| `read`          | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `ls`            | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `glob`          | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `grep`          | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `explore`       | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `lsp`           | `sealed`       | `hermetic` | reads `/**`               | `fs:read:/**`                 |
| `write`         | `compensable`  | `hermetic` | writes `/**`              | `fs:write:/**`                |
| `edit`          | `compensable`  | `hermetic` | reads and writes `/**`    | `fs:read:/**`, `fs:write:/**` |
| `apply_patch`   | `compensable`  | `hermetic` | reads and writes `/**`    | `fs:read:/**`, `fs:write:/**` |
| `update_plan`   | `sealed`       | `hermetic` | nothing                   | none                          |
| `fetch`         | `sealed`       | `expected` | nothing                   | `net:get:*`                   |
| `webfetch`      | `sealed`       | `expected` | nothing                   | `net:get:*`                   |
| `websearch`     | `sealed`       | `expected` | nothing                   | `net:post:*`                  |
| `http-post`     | `irreversible` | `expected` | nothing                   | `net:post:*`                  |
| `bash`          | `irreversible` | `expected` | nothing                   | `proc:spawn:*`                |
| `test`          | `irreversible` | `expected` | nothing                   | `proc:spawn:*`                |
| `shell_command` | `irreversible` | `expected` | nothing                   | `proc:spawn:*`                |
| `classify`      | `sealed`       | `expected` | nothing                   | `model:call:*`                |

`fetch` is `sealed` even though it leaves the machine, because a retrieval
leaves no durable state behind, and `classify` is `sealed` for the same reason:
a judgment read from Jev changes nothing. `http-post` is `irreversible` because the remote
side may already have acted.

## Narrowing to one call

The declared envelope is the registry-time worst case. It has to be, because the
declaration exists before any input does. `effectsFor` is the other half: hand
it one decoded input and it returns the envelope that call actually needs.

```ts
import * as Read from "@smthrs/std/Read"

Read.effects // reads: ["/**"]
Read.effectsFor({ path: "/workspace/notes.md" }) // reads: ["/workspace/notes.md"]
```

That is the difference between serializing every read in the workspace and
serializing the two calls that touch one file. Seven flows narrow to something
smaller than their declaration:

| Flow           | What the narrowing says                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `read`, `ls`   | reads the one `path` the input names                                                                                        |
| `write`        | writes the one `path` the input names                                                                                       |
| `edit`         | reads and writes the one `path` the input names                                                                             |
| `glob`, `grep` | reads the `root` subtree, or `/**` when no root is given                                                                    |
| `bash`         | in `hermetic` mode, `compensable` with the caller's own `reads` and `writes`; in `unhermetic` mode, the declared worst case |

The other eleven return their static envelope, and each says why in its own doc
comment. `apply_patch` is the interesting one: a patch names its files inside
its own text rather than in a decoded field, and the parse that finds them is
the parse that can fail, so the static envelope is the honest answer.

`Manifest.effectsFor` reaches the same functions by flow name, which is what a
host needs when it holds a name and a decoded input rather than a module:

```ts
import * as Manifest from "@smthrs/std/Manifest"

const narrow = Manifest.effectsFor["read"]
```

## Capabilities

A capability is an `action:resource` string on the declaration, and the
permission kernel decides whether the call is allowed to hold it. This package
uses five:

| Capability     | Flows                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `fs:read:/**`  | `read`, `ls`, `glob`, `grep`, `edit`, `apply_patch`, `explore`, `lsp` |
| `fs:write:/**` | `write`, `edit`, `apply_patch`                                        |
| `proc:spawn:*` | `bash`, `test`, `shell_command`                                       |
| `net:get:*`    | `fetch`, `webfetch`                                                   |
| `net:post:*`   | `http-post`, `websearch`                                              |

`explore` declares the union of the capabilities of the four flows it composes
from, sorted and deduplicated, so a model offered `explore` is offered exactly
the authority its readers need.

## Hermetic mode is a pre-check, not a sandbox

`bash` accepts `mode: "hermetic"` with explicit `reads` and `writes`, and the
handler checks the command against them before spawning anything. Read what the
check does, because the name promises more than it delivers.

The check is **lexical**. It tokenizes the command line, keeping quoted spans
whole, treats each physical line as its own command, classifies each path token
as a read or a write from the command that governs it, resolves both the token
and every declaration to a canonical absolute path, and refuses the call with
`outside_declared_reads` or `outside_declared_writes` when one falls outside.
Paths under `/dev/` are exempt, because `2>/dev/null` is process plumbing rather
than a filesystem access.

Then it starts an ordinary host process. Shell expansion, subprocesses, and
paths computed at runtime are not observed. So the check bounds **what a caller
declared it would do**, not what the process can do. A host that needs
confinement supplies a sandbox or an access-reporting boundary; this check alone
cannot prove hermetic execution.

Two inputs are refused rather than pre-checked, for the same reason:

- A hermetic call that also names a `container`. A container has its own
  filesystem, so declared host paths cannot describe it.
- A hermetic `script` whose `interpreter` is not a shell. The pre-check reads
  shell text, and Python is not shell text.

Both refusals arrive as `invalid_input` with a message naming the alternative.
See [Run a shell command](../guides/run-a-shell-command.md).
