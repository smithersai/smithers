---
title: "ToolRun"
description: "Runs one arbitrary external command for its side effect: a deploy, a migration, a release upload."
---

Runs one arbitrary external command for its side effect: a deploy, a migration,
a training-job launch, a release upload. This is the run-kind sibling of
[ToolBuild](tool-build.md). `ToolBuild` produces cached file outputs; `ToolRun`
performs an irreversible operation that has none.

```ts
import { Smithers } from "@smthrs/targets"

const fireworksKey = Smithers.HttpSecret(
  Smithers.Secret("FIREWORKS_API_KEY"),
  ["https://api.fireworks.ai"]
)

const sftLaunch = Smithers.ToolRun({
  command: "node",
  args: ["scripts/launch-job.mjs"],
  inputs: [Smithers.file("scripts/launch-job.mjs")],
  deps: [],
  secrets: [fireworksKey],
  env: { FIREWORKS_API_ORIGIN: Smithers.SecretOrigin("https://api.fireworks.ai") },
  cwd: "evals/authoring"
})

export const Package = Smithers.Package({
  targets: { sftLaunch }
})
```

This example runs your repository's `scripts/launch-job.mjs` from
`evals/authoring`. That script must use `process.env.FIREWORKS_API_ORIGIN` as
its API base and `process.env.FIREWORKS_API_KEY` in its authorization header.
The script is a declared input.

Run it explicitly, and only through the `run` verb:

```text
pnpm exec smithers-build run '//evals/authoring:sftLaunch'
```

## When to use it

Reach for `ToolRun` when an operation changes external state and has no file
output to cache. It is the deliberate escape hatch for a one-off command, the
way [ToolBuild](tool-build.md) is for a one-off build. When the operation has a
stable identity, add a purpose-built target type instead: the release targets
[NpmPublish](npm-publish.md) and [JsrPublish](jsr-publish.md) are the worked
examples, and adding a type is what
[build files declare targets, never commands](../../workspace/writing-build-files.md#build-files-declare-targets-never-commands)
asks for over reaching for this escape hatch. Do not use `ToolRun` for a check
whose exit code is a verdict: that is a cacheable gate, so it is a
[NodeTest](node-test.md), `Vitest`, or a lint target. Do not use it for a
long-lived watch process, which is [Dev](dev.md).

## Attributes

| Name                | Type                     | Default     | Description                                                                                   |
| ------------------- | ------------------------ | ----------- | --------------------------------------------------------------------------------------------- |
| `command`           | `string`                 | required    | The executable. Spawned directly, not through a shell.                                        |
| `args`              | `Array<string>`          | required    | Arguments passed after the executable.                                                        |
| `inputs`            | `Array<Input.Declared>`  | required    | Input declarations digested as key material and as ordering.                                  |
| `deps`              | `Array<Target.Target>`   | required    | Dependency targets. A `run` target may depend on a check that must pass first.                |
| `secrets`           | `Array<HttpCredential>`          | `[]`        | Destination-bound HTTP credentials. The child receives placeholders, never their values. |
| `env`               | `Record<string, string>` | `{}`        | Non-secret environment merged over the scrubbed tool environment.                                         |
| `expectedExitCodes` | `Array<number>`          | `[0]`       | Exit codes treated as success.                                                                |
| `timeoutMs`         | `number`                 | ten minutes | Overrides the shared exec runner's process-lifetime bound.                                    |
| `cwd`               | `string`                 | `"."`       | Workspace-relative directory the command runs in.                                             |

## Command

```text
<command> <args...>
```

Spawned once, through the irreversible exec action.

## Inputs

Collected from the attrs: every declaration in `inputs`.

## Secrets

A secret source is declared with `Smithers.Secret("ENV_NAME")` and bound to
exact HTTPS service origins with `Smithers.HttpSecret(source, audiences)`.
Pass those `HttpCredential` bindings in `secrets`, never literal values in
`env`.

At execution the child receives an opaque placeholder under the source's
environment-variable name, plus the loopback proxy endpoint. Only an HTTP
request to a declared audience can have that placeholder replaced with the
credential by the proxy. The real value never enters the child environment,
recorded plan, or content key.

HTTPS audiences require `Smithers.SecretOrigin(audience)` in `args` or `env`.
At spawn, that token becomes a loopback HTTP origin that forwards to the
declared HTTPS service over TLS and substitutes its credential. Ordinary HTTPS
`CONNECT` proxying cannot substitute inside TLS; a missing brokered-origin
token fails at execution with `invalid_payload`. A tool that
hardcodes its service host needs a host-owned adapter. Arbitrary non-HTTP
credential use is unsupported.

A confined runner must allow access to the proxy: `{ network: "loopback" }`
on macOS, or `{ network: true }` on Linux, where loopback-only confinement is
not supported. A closed network refuses a tool with secrets before spawn.
`ToolRun` has no `sandbox` attribute; a host confining its irreversible exec
runner must supply that network policy at the execution boundary. See
[Actions and boundaries](../../concepts/actions-and-boundaries.md#hermeticity).

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                     |
| --------- | ----------------------------------- |
| Kinds     | `run`                               |
| Verb gate | `run` only                          |
| Cacheable | Never                               |
| Executes  | Yes, through `ExecIrreversibleLive` |

## Why it is gated and never cached

`ToolRun` runs through the irreversible exec action, the same one the release
targets use. Three properties follow, and each is deliberate:

- **Never cacheable.** A side effect has no output to verify a cache entry
  against, and re-running is not free. `cache` is fixed to `false`; there is no
  attribute to turn it on.
- **Never retried or replayed blindly.** The irreversible tier tells the engine
  this operation must not be re-dispatched on a transient failure, nor executed
  by any verification or cache-population path.
- **`run` verb gate.** The target refuses to enter a `build`, `test`, `lint`, or
  `docs` graph, including as a transitive dependency. A `ci` run cannot pull a
  deploy or a job launch along with it. Run it on its own, on purpose.

## Notes

`env` is key material, so a value that varies per host or per run re-keys the
target every time. Put credentials in `secrets`, not `env`.

The command is spawned directly, never through a shell, so shell features
(globs, pipes, `&&`, variable expansion) do not apply. Pass a real argv.

## See also

- [ToolBuild](tool-build.md) for a cached build that produces file outputs
- [Dev](dev.md) for a long-lived process
- [NodeTest](node-test.md) for a gate whose exit code is a verdict
- [Writing target definitions](../../extending/writing-targets.md)
