---
title: "NodeBinary"
description: "Runs one JavaScript program under the build verb: a program whose product is files rather than a verdict."
---

Runs one JavaScript program under the build verb: a program whose product is
files rather than a verdict. Modelled on Bazel's `nodejs_binary`.

The build-verb counterpart of [NodeTest](node-test.md). They are separate types
because a target's participating verbs are fixed by its type. The planner
selects by kind, so one type covering both would put a release-packing program
in the graph of `smithers-build test`.

```ts
import { Smithers } from "@smthrs/targets"

const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })

// node scripts/pack-release.mjs dist/release-packs
const releasePack = Smithers.NodeBinary({
  runtime,
  entry: Smithers.file("//scripts/pack-release.mjs"),
  args: ["dist/release-packs"],
  srcs: [Smithers.glob("//scripts/**/*.mjs")],
  deps: []
})

export const Package = Smithers.Package({
  targets: { releasePack }
})
```

## Attributes

| Name      | Type                     | Default  | Description                                             |
| --------- | ------------------------ | -------- | ------------------------------------------------------- |
| `runtime` | `Runtime.Runtime`        | required | The declared interpreter. Never a hardcoded `node`.     |
| `entry`   | `Input.File`             | required | The program. A `//`-rooted path is workspace-relative.  |
| `args`    | `Array<string>`          | required | Arguments passed after the entry point, at most 64.     |
| `srcs`    | `Array<Input.Declared>`  | required | What the program reads beyond its own entry point.      |
| `deps`    | `Array<Target.Target>`   | required | Dependency targets.                                     |
| `env`     | `Record<string, string>` | `{}`     | Environment merged over the host bootstrap environment. |
| `cwd`     | `string`                 | `"."`    | Workspace-relative directory the program runs in.       |

## Command

```text
<runtime> <entry> <args...>
```

## Outputs

None declared. These programs write through the package manager or a compiler,
outside anything the build system can digest as a hermetic output, so the
dependency edge to the target that consumes the result is the contract. Results
are never replayed for the same reason: a stored result would not identify what
produced it.

## Channels and status

|          |                                             |
| -------- | ------------------------------------------- |
| Kinds    | `build`                                     |
| Success  | `Exec.Result`                               |
| Error    | `Exec.ExecError`                            |
| Executes | Yes. The executor provides the exec action. |

## See also

- [NodeTest](node-test.md)
- [ToolBuild](tool-build.md): the escape hatch for a toolchain with no target
  type of its own
