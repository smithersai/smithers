---
title: "Choose which jj binary runs"
description: "Point the Node and Bun layers at a specific jj with SMITHERS_JJ_PATH, read the resolution back with resolveJjBinary, and print the operator guidance smthrs doctor shows."
sidebar:
  order: 4
---

`NodeJj` resolves an absolute host executable path when its layer is built.
Its version preflight and repository operations use that same path through the
same runner.
`@smthrs/jj/node/resolveJjBinary` answers exactly that, and
[`smthrs doctor`](/cli/doctor) prints the answer.

## Override the binary

```bash
export SMITHERS_JJ_PATH=/opt/homebrew/bin/jj
```

`SMITHERS_JJ_PATH` is an operator saying "run this jj", so the override is the
file that actually runs, not a hint. Resolution order is short:

1. `SMITHERS_JJ_PATH`, when it names a file that exists.
2. `PATH`, searched for `jj` (`jj.exe` on Windows). A directory named `jj`,
   such as a jj source checkout, is skipped.

An override that names a directory resolves as not executable, with a hint
that names the directory.

An override that names an existing file stays authoritative **even when it is
not executable**, so a broken explicit path is reported instead of a different
binary being quietly substituted. An override that names nothing that exists
falls through to `PATH`, and the fall-through is reported rather than silent:
an operator whose typo was disregarded otherwise gets a healthy report for a jj
they did not choose.

A relative override resolves against the host working directory when the layer
is built. A relative PATH entry, `.` included, is skipped rather than resolved:
`NodeJj.layer` treats that working directory as the repository and agents write
files there, so a `jj` written into it is never the one the host runs.
Repository working directories and later changes to PATH
or `SMITHERS_JJ_PATH` cannot select another executable for that layer. A contained
spawner must be able to execute the selected absolute path; its own PATH does
not change the selection. The version probe also runs through that spawner,
without a repository cwd.

Selection spawns nothing and never fails, so a layer builds on a host without
jj. The first operation probes the selected path. When nothing was found, that
operation fails with `not_installed`; install jj and restart the process, since
the layer keeps the selection it made when it was built.

## Bound the version probe

The first operation of a Node or Bun layer waits up to 5000 ms for
`jj --version`, then interrupts the probe and awaits cleanup. A loaded machine
can miss that budget, or the spawner's own startup bound (a `PlatformError`
tagged `TimedOut`), so either timeout is retried once with a fresh budget. A
second timeout fails the operation with `JjError`, `code: "unknown"`,
`method: "version"`, and `cause.code: "ETIMEDOUT"`. The command and message
identify the resolved executable. Contained spawner cleanup can add its
shutdown grace period to each attempt.

Provide `NodeJj.StartupTimeoutMs` to the layer to override the budget. The
layer reads it when it is built:

```ts
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Layer from "effect/Layer"

const jj = NodeJj.layerAt("/srv/repository").pipe(
  Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs)(1_500))
)
```

The value must be positive, finite, and at most 2147483647 ms. An invalid value
fails the first operation with `JjError` and `cause.code: "EINVAL"` before
anything is spawned. A timeout is not cached as a version result; the next
operation retries. Each layer's budget also bounds its wait for an in-progress
shared probe. Repository operations retain their existing lifetime and
cancellation behavior.

## Read the resolution

```ts
import { describe, resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"

const resolved = resolveJjBinary()
console.log(describe(resolved))
```

`resolveJjBinary` always returns a command. When jj is genuinely absent it
answers the bare name `jj` with `executable: false` and a hint, which keeps the
typed `not_installed` failure while giving `doctor` something specific to print.
`NodeJj` does not spawn this unresolved fallback.

`Resolved` carries what is known:

| Field        | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `path`       | The absolute candidate path, or `jj` when none was found.             |
| `source`     | `"env"` for an override, `"path"` for a PATH lookup.                  |
| `executable` | Whether the operating system can execute the candidate.               |
| `hint`       | Present only when the resolution is known to be unusable.             |
| `variable`   | The override variable that supplied `path`, when `source` is `"env"`. |
| `ignored`    | An override that named a path nothing exists at, and was skipped.     |

`describe` renders one line for an operator:

```text
jj: /opt/homebrew/bin/jj (SMITHERS_JJ_PATH)
jj: not found - No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH.
```

## Test a resolution without staging a filesystem

Every probe is injectable, so a test can pin the resolution order outright:

```ts
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"

const resolved = resolveJjBinary({
  environment: { PATH: "/usr/bin", SMITHERS_JJ_PATH: "/opt/jj" },
  platform: "linux",
  exists: (file) => file === "/opt/jj",
  executable: () => false
})
// { path: "/opt/jj", source: "env", executable: false, variable: "SMITHERS_JJ_PATH", hint: ... }
```

`overrideVariables` is the exported list of environment names the resolver
reads, so a diagnostic can enumerate them rather than hard-coding the string.

## The guidance an operator gets

`permissionHint(file, platform)` builds the remediation for a named jj that
cannot be executed. On macOS it adds the quarantine tip, because a downloaded
binary carries `com.apple.quarantine` and refuses to run with an error that
names neither the attribute nor the fix:

```text
Cannot execute the jj binary at /opt/jj. Run: chmod +x '/opt/jj'; xattr -d com.apple.quarantine '/opt/jj'; or point SMITHERS_JJ_PATH at a working jj.
```

The path is quoted with `shellQuote`, which is also exported. The hint is
advice an operator pastes into a shell, and the path in it is whatever they put
in `SMITHERS_JJ_PATH`: unquoted, a space makes the advice silently wrong and a
`;` or `$(...)` makes the paste run commands the hint never named.

`isExecutable(file, options)` is the probe behind all of this. It checks the
execute bit on POSIX and mere existence on Windows, where a vendored `.exe`
does not use POSIX mode bits. It is a probe and never a `chmod`: an unusable
candidate is reported, not repaired.

## What this package does not do

It vendors no `jj` binaries and downloads none. There is no bundled-package
branch to fall back to, so an absent jj is an operator's install, not a runtime
fetch.
