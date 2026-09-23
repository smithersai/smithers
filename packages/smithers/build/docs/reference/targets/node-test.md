---
title: "NodeTest"
description: "Runs one JavaScript program as a test gate, where the program's exit code is the verdict."
---

Runs one JavaScript program as a test gate: the program's exit code is the
verdict. Modelled on Bazel's `nodejs_test`.

This is what a repository's shell-script gates become. `node --test
scripts/pack-release.test.mjs`, `node scripts/browser-check.mjs`, and `bun
e2e/run.ts` are all the same shape, a program that passes or fails, and each one
is a target here, planned, keyed, addressable by label, and runnable locally
by the name CI uses.

```ts
import { Smithers } from "@smthrs/targets"

const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })

// node --test scripts/pack-release.test.mjs
const packManifest = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/pack-release.test.mjs")]),
  srcs: [Smithers.glob("//scripts/**/*.mjs")],
  deps: []
})

// node scripts/smoke-release.mjs dist/release-packs
const releaseSmoke = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/smoke-release.mjs"), ["dist/release-packs"]),
  srcs: [Smithers.glob("//scripts/**/*.mjs")],
  deps: [releasePack]
})

export const Package = Smithers.Package({
  targets: { packManifest, releaseSmoke }
})
```

## Attributes

| Name      | Type                     | Default  | Description                                                                    |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `runtime` | `Runtime.Runtime`        | required | The declared interpreter. Never a hardcoded `node`.                            |
| `runner`  | `Runner`                 | required | How the program is started. See [Runners](#runners).                           |
| `srcs`    | `Array<Input.Declared>`  | required | What the program reads beyond its own entry point, digested as key material.   |
| `deps`    | `Array<Target.Target>`   | required | Dependency targets. A gate that consumes a build's product depends on it here. |
| `env`     | `Record<string, string>` | `{}`     | Environment merged over the host bootstrap environment.                        |
| `cwd`     | `string`                 | `"."`    | Workspace-relative directory the program runs in.                              |

## Runners

The runner is a discriminated union, so the fields one form does not have are
fields a PACKAGE.ts file cannot write: no argument list on a test-runner run, no
file list on an entry-point run.

| Constructor                | Renders (Node)          | Renders (Bun)          |
| -------------------------- | ----------------------- | ---------------------- |
| `testRunner([a, b])`       | `node --test a b`       | `bun test a b`         |
| `entrypoint(file, [args])` | `node <file> <args...>` | `bun <file> <args...>` |

Every spelling difference between interpreters is resolved by
[`Runtime`](../../concepts/targets.md), so switching the workspace runtime
changes the argv without touching a declaration.

A `//`-rooted path is relative to the workspace root, which is what the argv
needs when `cwd` is the workspace root. A package-relative path passes through
unchanged, for a target whose `cwd` is the package.

## Command

```text
<runtime> <runner argv>
```

## Inputs

Collected from the attrs: the runner's declared files and every entry in `srcs`.

## Outputs

None. A gate's product is its exit code.

## Channels and status

|          |                                             |
| -------- | ------------------------------------------- |
| Kinds    | `test`                                      |
| Success  | `Exec.Result`                               |
| Error    | `Exec.ExecError`                            |
| Executes | Yes. The executor provides the exec action. |

## See also

- [NodeBinary](node-binary.md): the build-verb counterpart
- [buildAndCheckPackage](standard-package.md): emits the conventional per-package
  circular-dependency guard as one of these
- [GithubCiGen](github-ci-gen.md)
