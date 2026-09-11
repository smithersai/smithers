---
title: "Writing target definitions"
description: "Target.make: the attrs schema, the pure plan-time implementation, declared inputs and outputs, verb-effective attrs, and typed failures."
---

`Target.make(id, options)` creates a callable target definition. The result is a
function from attributes to a target, carrying `id`, `attrs`, and `kinds`.

```ts
// Typecheck.ts, in @smthrs/targets
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

export const Attrs = Schema.Struct({
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  buildMode: Schema.Boolean,
  incremental: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

export const Typecheck = Target.make("Typecheck", {
  attrs: Attrs,
  kinds: ["build"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: ["pnpm", "exec", "tsc", "-p", attrs.tsconfig.path, "--noEmit"]
    })
})
```

## Options

| Option           | Required | Purpose                                                              |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `attrs`          | Yes      | The target's attribute schema. It is also the flow's payload schema. |
| `kinds`          | Yes      | Which verbs the target participates in. Deduplicated.                |
| `implementation` | Yes      | The pure plan-time body: decoded attrs to a plan node.               |
| `success`        | No       | The success schema. Defaults to `Schema.Void`.                       |
| `error`          | No       | The error schema. Defaults to `Schema.Never`.                        |
| `inputs`         | No       | Extra declared inputs derived from the decoded attrs.                |
| `cache`          | No       | A boolean or a function of the decoded attrs. Defaults to `true`.    |
| `attrsForKind`   | No       | Map the decoded attrs to what one verb executes with.                |

## The attrs schema

Attrs are an Effect `Schema.Struct`. Three field types have meaning to the
planner:

| Field type                                                    | Effect                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| `Input.Declared`, `Input.File`, `Input.Glob`, `Input.GitDiff` | Collected as a declared input and digested by the planner |
| `Target.Target`                                               | Collected as a dependency edge                            |
| Anything else                                                 | Plain key material                                        |

Give an attribute a constructor default when it should be optional at the call
site:

```ts
cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
dryRun: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
```

Every tool-running catalog target takes a `cwd` attribute defaulting to `"."`. Do
the same in a new target: a package-level `PACKAGE.ts` needs to say where its tool
runs.

Keep attrs declarative. Both the collector and the key encoder walk them, and the
encoder fails closed: an attribute whose value is a function, a class instance, a
`Date`, a `Map`, a bigint, `NaN`, or a reference cycle fails the plan rather than
hashing to something a different attr could also produce.

A target that produces files declares them with `outputs`, a function from decoded
attrs to a `cwd` and an ordered list of paths. The declaration is what the
executor measures on a fresh success and on a cache admission, so an
implementation that returns success without a matching output manifest fails its
target. `ToolBuild`, `TsBuild`, and `DtsBuild` are the worked examples.

## The implementation

The implementation is a pure function from decoded attrs to a plan node. It runs
during target construction, records nodes, and executes nothing.

Compute argv, choose branches, and derive strings freely. Do not read a file,
spawn a process, or return a promise.

```ts
const checkArgv = (attrs: Attrs): ReadonlyArray<string> =>
  attrs.buildMode
    ? PackageManager.exec(attrs.packageManager, [
      "tsc",
      "-b",
      attrs.tsconfig.path,
      ...(attrs.incremental ? [] : ["--force"])
    ])
    : PackageManager.exec(attrs.packageManager, [
      "tsc",
      "-p",
      attrs.tsconfig.path,
      "--noEmit",
      ...(attrs.incremental ? ["--incremental"] : [])
    ])
```

### Running a tool

`Exec.runTool(payload)` records one call to the shared exec action:

```ts
Exec.runTool({
  cwd: attrs.cwd,
  argv: PackageManager.exec(attrs.packageManager, ["eslint", "--max-warnings", String(attrs.maxWarnings)]),
  env: { CI: "1" }, // optional, merged over process.env
  expectedExitCodes: [0, 1], // optional, defaults to [0]
  after: someUpstreamResult // optional, an ordering dependency
})
```

Catalog targets resolve their tool through `PackageManager.exec` of the declared
manager, so the manager name and version stay key material and a workspace on
another manager uses the same targets.

### Combining nodes

```ts
import * as Node from "@smthrs/plan/Node"

// Run several nodes and collect a record.
Node.all({
  check: attrs.lint ? Exec.runTool({/* ... */}) : Node.succeed(null),
  format: attrs.format ? Exec.runTool({/* ... */}) : Node.succeed(null)
})

// Sequence one action behind another.
Exec.runTool({ cwd, argv: buildArgv(attrs) }).pipe(
  Node.andThen(CaptureOutputs.call({ cwd: attrs.cwd, paths: [attrs.outDir] }))
)
```

Two keyless dispatches of one action at the same time are refused with
`ConcurrentKeylessDispatch`. Sequencing is what prevents it: give
`Node.andThen` the next action call itself, or use `Node.bindPlanned` to pass the first step's planned
result into the second payload's `after` field, so the ordering is a material
dependency. `captureOutputs` takes the first route.

### Declaring outputs

A build target that produces files ends with `captureOutputs`, the shared step that
digests each declared output path through the `CaptureOutputs` action:

```ts
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

export const TsBuild = Target.make("TsBuild", {
  attrs: Attrs,
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  implementation: (attrs) =>
    captureOutputs(
      Exec.runTool({ cwd: attrs.cwd, argv: buildArgv(attrs) }),
      attrs.cwd,
      [attrs.outDir]
    )
})
```

`captureOutputs` sequences capture behind the producing step it is given.
`BuildError` is the union of `Exec.ExecError` and `OutputError`, because the tool
run and the capture of what it produced can each fail.

`Outputs` is `{ outputs: Array<{ path, fileCount, contentDigest }> }`. A
directory contributes every file beneath it and a plain file contributes itself.
Every declared output is required: a tool that exits zero without creating one
fails the target, exactly as it does in Bazel. An empty directory is a valid
output; a missing path is not.

The `outputs` metadata a target declares is validated when a target is
constructed, so a bad declaration fails the PACKAGE.ts load with a message naming
the target. Keep every declared path workspace-relative, below `cwd`, outside
`.flows` and `.git`, and non-overlapping: `dist` and `dist/index.js` cannot both
be outputs of one target. [ToolBuild](../reference/targets/tool-build.md#what-a-declaration-may-name)
lists the whole target.

Two limits of the plan AST decide the shape above, and a target that ignores them
fails at execution rather than at build time:

- `Node.bindPlanned`, and `Node.map`, keep their plan-time
  function in a side table the AST loses on its way to the engine. Executing a
  target built from either refuses with `incomplete_graph` or `missing_operation`.
  Give `Node.andThen` a node, and let the last action's own success type be what
  the target declares.
- The ordering edge is recorded against exactly the node `Node.andThen` is
  given. Wrapping the next step in another node lets the interpreter settle the
  wrapper's children concurrently, which reintroduces the concurrent dispatch
  the sequencing was for.

## Extra inputs

Use `inputs(attrs)` when key material must include a file that is not already a
declared attribute value.

```ts
// PackageJsonCheck: the output file is an input, so editing it re-keys.
const packageJsonInputs = (attrs) => [Input.file(attrs.output)]

// GithubCiGen: non-writing modes read the checked-in workflow.
const workflowInputs = (attrs) => attrs.mode === "write" ? [] : [Input.file(attrs.output)]
```

## Cacheability

```ts
const neverCache = false
const pureCheck = true // DocsParity, Filegroup, PackageJsonCheck
const githubCache = (attrs) => attrs.mode !== "write"
const toolBuildCache = (attrs) => attrs.cache // caller's explicit choice
```

The default is `false`. Opt in only when attrs, declared inputs, dependency
keys, implementation identity, and toolchain identity completely determine the
result. A target that mutates the working tree, holds a long-lived process, calls
a model, changes external state, or invokes an incompletely keyed external
tool stays non-cacheable.

## Per-verb attrs

A target declaring several kinds can execute a different form under each one.
`attrsForKind(kind, attrs)` maps the decoded attrs to what that verb runs with.
Return the same object to leave the verb alone.

```ts
// GithubCiGen: build writes, lint checks for drift.
const attrsForKind = (kind, attrs) =>
  kind === "lint" && attrs.mode !== "check" ? { ...attrs, mode: "check" as const } : attrs
```

When the mapping returns a different value, the target re-derives declared inputs
from the mapped attrs, re-runs its own `inputs(attrs)` function against it, and
re-evaluates `cache(attrs)`. Dependencies never vary by verb.

`Metadata.forKind(kind)` exposes the result as a `KindView` of
`{attrs, inputs, cacheable}`. The planner uses it for `build`, `test`, `lint`,
`run`, and `docs`, and uses the declared view for `graph` and `query`.
Key material is built from the resolved view, so one target can have two content
keys, and the executor passes the same resolved attrs to the flow.

Use this when one target genuinely has two forms of the same work. Declare two
targets when the two forms have different dependencies.

## Typed failures

Declare the error channel as a schema. Use a tagged error class for a target-specific
failure:

```ts
export class DriftError extends Schema.TaggedError<DriftError>()(
  "smithers-build/DriftError",
  { path: Schema.NonEmptyString, message: Schema.NonEmptyString }
) {}
```

A target that can fail two ways declares a union:

```ts
error: Schema.Union([WriteFileError, DriftError])
```

Never throw from an implementation for an expected failure. A thrown error at
plan time fails module evaluation and takes the whole command with it. Throwing
is correct only for an attribute value that can never be valid, as `Clean` does
when a declared path escapes its directory.

## Declaring a new action

A target needing an effect the shared exec action cannot express declares its own
action and ships an implementation layer.

```ts
export const WriteFile = Action.make("smithers-build/write-file", {
  payload: FilePayload,
  error: WriteFileError,
  tier: "sealed"
})

export const WriteFileLive = (options: { readonly workspaceRoot: string }) =>
  WriteFile.toLayer((payload) => writeGeneratedFile(options.workspaceRoot, payload))
```

Choose `irreversible` when the effect changes external state and must never be
retried blindly or replayed. `ExecIrreversible` is the catalog's example.

An action call with no implementation in scope refuses with `unresolved_action`
before anything runs. That is a wiring error, not a runtime contingency, so a new
action needs its layer added wherever plans are executed. The CLI executor
supplies the exec and irreversible-exec, capture-outputs, expand-filegroup,
write-file, check-file, check-docs, llm-review, sync-package-json,
scaffold-package, not-implemented, and install implementations. An action absent
from that list plans but cannot execute.
See [Actions and boundaries](../concepts/actions-and-boundaries.md).

## Registering the target

Export it from the package that holds your catalog:

```ts
/** @category targets @since 0.1.0 */
export { Typecheck } from "./Typecheck.ts"
```

If the target needs non-default key material, add it to the planner's `layers`
or `capabilities` table in [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli). Both tables
are hand-maintained today; deriving them from the real flow graph is an open
design question.

Then add a page under [the target catalog](../reference/targets/README.md).

## Next

- [Writing macros](writing-macros.md)
- [Default targets](default-rules.md)
- [Actions and boundaries](../concepts/actions-and-boundaries.md)
