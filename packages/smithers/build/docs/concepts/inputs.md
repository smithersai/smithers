---
title: "Inputs"
description: "The file(), glob(), gitDiff(), nodeModules() and link() input declarations: how each resolves against a package, when the planner digests it, and what revalidation catches."
---

An input is a declaration of content a target depends on. Declaring it is pure;
measuring it happens later.

## The three constructors

```ts
import { Smithers } from "@smthrs/targets"

const sources = Smithers.glob("src/**/*.ts")
const excluded = Smithers.glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] })
const config = Smithers.file("vitest.config.ts")
const rootConfig = Smithers.file("//eslint.jsdoc.js")
const changes = Smithers.gitDiff("origin/main")
```

Each returns a plain tagged object.

| Constructor                  | Value                                |
| ---------------------------- | ------------------------------------ |
| `glob(pattern, { exclude })` | `{ _tag: "Glob", pattern, exclude }` |
| `file(path)`                 | `{ _tag: "File", path }`             |
| `gitDiff(base)`              | `{ _tag: "GitDiff", base }`          |

`nodeModules(path)` declares an installed dependency tree; see
[Installed trees](#installed-trees). `link(path)` declares a symbolic link,
keyed by its target string; see [Symbolic link inputs](#symbolic-link-inputs).
`Input.isDeclared(value)` tests for a
declared input's tag. The union is
`Input.Declared`.

## No I/O at evaluation

The constructors read nothing. A target call collects the declared values it finds
in its attrs, and a target may add more through its `inputs(attrs)` function. That
is the whole of input declaration.

The planner expands and digests them during discovery, in
`Workspace.expandInputs`. One plan reads each distinct declaration of a package
once, however many targets declare it, so every target keys the same bytes for
a shared input. The result is an `ExpandedInput` per declaration:

```ts
interface ExpandedInput {
  readonly declaration: Input.Declared
  readonly files: ReadonlyArray<{ path: string; digest: string | undefined; link?: string }>
  readonly digest: string
}
```

A row for a symbolic link input carries the link's target string in `link`.

`digest` is the sha256 of the JSON of the file list. That digest is what reaches
the target's key material. The pattern text and the path do not.

## Path resolution

A declared path or pattern resolves against the package directory of the target
that declared it. A value starting with `//` resolves from the workspace root
instead.

```ts
// In packages/greeter/PACKAGE.ts
file("tsconfig.json") // packages/greeter/tsconfig.json
file("//eslint.jsdoc.js") // eslint.jsdoc.js
glob("src/**/*.ts") // packages/greeter/src/**/*.ts
```

The result is a normalized workspace-relative posix path. A value that escapes
the workspace throws `declared input escapes the workspace: <value>`.

The package directory used here is the target's `PACKAGE.ts` directory, which is
not the same thing as the target's `cwd` attribute. `cwd` is where the tool
process starts. Both are usually the same directory, and `buildAndCheckPackage`
passes the package directory as `cwd`, but they are resolved independently.

## Glob expansion

Expansion walks the real filesystem, starting at the pattern's static prefix, the
longest leading run of segments containing no glob metacharacter.

The walk:

- honors every `.gitignore` from the workspace root down to the walked
  directory,
- skips `.git` entries,
- skips `node_modules` directories, unless a `.gitignore` negation rule
  un-ignores one (see [`node_modules` the workspace tracks](#node_modules-the-workspace-tracks)),
- stops at subpackage boundaries: it never descends into a subdirectory holding
  a `PACKAGE.ts` file,
- skips the resolved cache directory and the fixed `.flows/store` subtree
  unconditionally, ignored or not,
- matches the result against the pattern with `minimatch` and `dot: true`,
- removes anything matching an `exclude` pattern,
- sorts.

### Globs are package scoped

Like Bazel, a glob only sees its own package. A recursive pattern declared in
`packages/greeter` matches `packages/greeter/src/index.ts`, but stops before
`packages/greeter/examples/index.ts` once `packages/greeter/examples/PACKAGE.ts` exists.
Those files belong to the subpackage's own targets; a target that wants them
depends on that package's label instead.

The `PACKAGE.ts` name is compared exactly, so a source file named `build.ts` is
never mistaken for a package marker on a case-insensitive filesystem.

The target applies to every glob in every target. It also applies before the
pattern's static-prefix directory: starting a walk at
`packages/greeter/examples/src` does not bypass a `packages/greeter/examples/PACKAGE.ts`
boundary. A `//`-rooted glob resolves its pattern from the workspace root but
remains scoped to the declaring package: `//packages/greeter/src/**/*.ts` is legal
from `packages/greeter`, while `//*.ts` is not. Depend on another package's label
instead. This deliberately follows Bazel package boundaries; only `file()`
keeps the smithers build extension that permits `//`-anchored cross-package file
references.

Repeated expansion of an unchanged tree is therefore deterministic. A pattern
whose static prefix does not exist, is not a real directory, is unreachable
through real directories, lands inside a `node_modules` no negation rule
un-ignores, or lands inside host state expands to an empty list.

### `node_modules` the workspace tracks

An install is host state, so a glob never walks a `node_modules` directory by
default, whether the directory lies below the pattern's static prefix or on
it. A fixture can still track paths inside one, such as a link standing in for
an installed package. Git tracks them only because a `.gitignore` negation
rule un-ignores the directory, and the walk follows the same rule:

```gitignore
# consumer/.gitignore
!node_modules/
node_modules/*
!node_modules/agent
```

With that file, `glob("consumer/**")` lists `consumer/node_modules/agent` and
nothing else inside `consumer/node_modules`. Without a negation rule the walk
skips the directory, as it always has: a workspace whose `.gitignore` says
nothing about an install cannot tell an install from tracked content, and
digesting an install would key every installed file.

### The walk stays inside the workspace

Every directory from the workspace root down to the static prefix, and every
directory below it, must be a real directory whose resolved path is still inside
the canonical workspace root.

- A symbolic link to a directory is never descended. It can neither move the
  walk outside the workspace nor make it loop.
- A directory that resolves outside the root, or that is replaced while it is
  being read, fails the expansion. It does not contribute files under names that
  mean nothing in this workspace.
- A `.gitignore` that cannot be read fails the expansion. It is not treated as
  an empty file, because a matcher that ignores nothing pulls generated output
  into key material.

## File digests

`digestFile` returns the sha256 of the file's content, or `undefined` when the
file does not exist. A declared-but-missing file still contributes deterministic
key material: the file list records `{path, digest: undefined}`.

Only a missing file is missing. A permission error, an unreadable parent
directory, and every other failure is reported rather than digested as absence,
so a workspace never plans as though a file it could not read had been deleted.

Content streams through a buffer of at most 256 KiB, and no larger than the file
plus one byte, so a large input costs a fixed amount of memory rather than its
own size, and a small one costs about its own size. The read happens through a descriptor that
is checked to be the same regular file the path named, and checked again after
the last byte: a file replaced or rewritten mid-digest fails rather than
producing a digest of a file that never existed.

A declared input is a regular file. A FIFO, a socket, a device, and a directory
are refused; without that, a FIFO nobody writes to would block planning forever.

### Remembered digests

Planning reads each file once per invocation, however many targets and verbs
declare it, and remembers each digest for the next invocation in
`<cache directory>/plan/file-digests.json`. A remembered digest is used only
when the file's `lstat` status equals the status it was read at: device, inode,
size, modification time and status-change time, at full resolution. Every write
and every `utimes` call moves the status-change time, which an unprivileged
process cannot set back, so an equal status names the same bytes. Any other
status reads the file again.

A digest is saved for the next invocation only when both times are at least two
seconds older than the start of the read. A write in the same timestamp tick as
a read could leave the status unchanged, so a recently changed file is read by
every invocation until it settles; within one invocation it is read once, as
one plan already reads a shared declaration once for all its targets. Confinement and the regular-file checks run before the index is
consulted, so a remembered row never admits a path the read would refuse.

The `plan` directory holds a `.gitignore` that ignores its own contents, so a
plan leaves no untracked file in a checkout that does not ignore the cache
directory. The index is a cache, not key material: keys are the same with or
without it.
A missing, malformed or corrupt index, or one of another format, is ignored and
every file is read. Deleting the file is always safe.

### Symbolic links

A symbolic link is followed only when its whole resolution stays inside the
canonical workspace root and ends at a regular file. Such a link is content:
`file()` and a glob digest it identically, so the two never disagree about a
target's inputs.

Every other link (to a directory, dangling, or resolving outside the
workspace) is never followed:

- A `file()` declaration naming a link to a directory fails with
  `link_input_refused` and names `link()` as the constructor that declares
  it. One naming a link that leaves the workspace fails by name. A dangling
  one is recorded as absent, as a missing file is.
- A glob that is a target's declared input lists it as a link input, keyed by
  its target string (see [Symbolic link inputs](#symbolic-link-inputs)), and
  fails with `link_input_refused`, naming the link, when that string is
  absolute or leaves the workspace. A tracked path is never silently dropped
  from a target's key.
- Every other caller of glob expansion, such as a lint rule listing the files
  it reads, skips it: there are no bytes at a link to a directory to read.

A `PACKAGE.ts` that is a link is a package marker exactly when the workspace index
would import it: when it resolves, inside the workspace, to a regular file. A
link can therefore neither invent a package boundary nor erase one.

A `file()` declaration that resolves inside host state expands to an empty file
list, so cache content can never reach a digest.

## Git diffs

A `gitDiff(base)` declaration expands to the range `<base>...HEAD`.

1. `git diff --name-only -z <base>...HEAD --` lists the changed paths.
2. Paths inside host state are dropped and the rest are sorted. Each is recorded
   with `digest: undefined`; the file list names what changed, not its content.
3. `git diff --binary <base>...HEAD -- <paths>` produces the patch text, and the
   declaration's digest is the sha256 of that text.

An empty change set digests the empty string.

This makes a diff first-class key material: a target re-keys exactly when the
patch content changes. `LlmLint` is the target built on it.

## Installed trees

```ts
const effect = Smithers.nodeModules("//experiments")
```

`nodeModules(path)` returns `{ _tag: "NodeModules", path }`. `path` names a
directory that holds a `package.json`, a lockfile and the `node_modules` an
install made from them. Declare it on a target whose tool resolves modules
from a directory that is not above the tool's own working directory; the
trees above it need no declaration.

| Part                               | Role                                       |
| ---------------------------------- | ------------------------------------------ |
| `<path>/package.json`              | Key material                               |
| Every lockfile present in `<path>` | Key material                               |
| `<path>/node_modules`              | Readable under confinement; never hashed   |
| Everything else in `<path>`        | Neither keyed nor readable unless declared |

The lockfiles read are `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`,
`package-lock.json`, `pnpm-lock.yaml` and `yarn.lock`. The lockfile is the
install's identity, which is the contract the trees above the working
directory already have: installing from an unchanged lockfile reproduces the
tree, so the installed files are not digested, and editing them by hand does
not re-key the target. Install with the manager's frozen-lockfile mode before
running `smthrs`.

A directory with no `package.json`, or with no lockfile, fails planning and
names what is missing. An install with no identity is never granted.

`smthrs affected` selects the target when the manifest or a lockfile changes.
The declaration is an input of the target that reads the install, not a
`Filegroup` member; share one constant between the targets that need it.

## Symbolic link inputs

```ts
const agent = Smithers.link("consumer/node_modules/agent")
```

`link(path)` returns `{ _tag: "Link", path }`. `path` names a tracked symbolic
link (git mode `120000`). A test whose meaning depends on a link, such as a
fixture whose `node_modules/agent` points at a sibling package, declares the
link itself.

| Part                          | Role                                              |
| ----------------------------- | ------------------------------------------------- |
| The link's target string      | Key material                                      |
| The link, at its path         | Present under confinement, with the same target   |
| What the link points at       | Neither keyed nor readable unless declared itself |

The identity is the target string `readlink` returns, never the content
behind it. Retargeting the link re-keys the target. Editing files behind the
link re-keys it only when those files are declared themselves, as any other
input would. Declare both to read through the link:

```ts
const test = S.Shell.Test({
  shell: "node consumer/run.js",
  data: [S.link("consumer/node_modules/agent"), S.glob("consumer/agent/**")]
})
```

The planner refuses with `link_input_refused`, naming the path, when:

- the path is not a symbolic link,
- the target is absolute, or
- the target, resolved lexically from the link's directory, leaves the
  workspace.

An absolute or escaping target names something outside the tree the key
covers: the key would say nothing about what the link reaches on another
checkout, and the sandbox would need to grant a host path to make the link
resolve. `nodeModules()` draws the same line from the other side: it admits a
linked tree only when the link resolves to a real install with a manifest and
a lockfile, and otherwise fails closed. A dangling link inside the workspace is
admitted, because its target string is still the whole of its identity.

Under confinement the run sees the link as a link: bubblewrap creates it in
the workspace tmpfs, and seatbelt grants the link itself as a literal path.
Neither grants anything through it. Docker binds paths, and a bind of the link
would grant what it points at, so a Docker-confined target with a link input
fails closed.

A link input never becomes an output, and remote caching is unchanged: inputs
are key material, never uploaded. A link a tool produces is an output only
inside a declared `outDirs` directory, where it is captured and restored as a
link; a link whose target leaves that directory is refused at capture. A
declared output file that is a link fails the target and names `outDirs`.

`smthrs affected` selects the target when the link's path changes, which is
how git and jj report a retarget. A change behind the link selects the targets
that declare the changed file, not the target that declares the link.

### Why a constructor of its own

Two designs were compared. Teaching `file()` to admit a link would give one
constructor two identities: a link to a file keys the file's content, as it
always has, while a link to a directory would key a string. A link that is
retargeted from a file to a directory would silently change what its
declaration means, and the confinement for `file()` grants a read while a link
must grant nothing. `link()` names the one identity it has, keeps every
existing `file()` key unchanged, and makes the refusal for a link `file()`
cannot read point at the declaration that can.

## Sharing declarations

Declare once and reuse. Each target digests the declaration independently.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const sources = S.glob("src/**/*.ts")
const sourceFiles = S.Filegroup({ srcs: [sources] })
const lintFiles = S.Filegroup({ srcs: [sources] })

export const Package = S.Package({ targets: { sourceFiles, lintFiles } })
```

Export a declaration for other `PACKAGE.ts` files to import:

```ts
// PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

export const rootJSDocConfig = S.file("//eslint.jsdoc.js")
export const Package = S.Package({ targets: {} })
```

```ts
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { rootJSDocConfig } from "../../PACKAGE.ts"

const lint = S.EsLint({
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  configs: [S.file("eslint.config.js"), rootJSDocConfig],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/greeter"
})

export const Package = S.Package({ targets: { lint } })
```

An exported `file()` value is not a target and gets no label.

## Inputs are not outputs

Declaring an input never tells a tool what to read. It tells the planner what to
digest. The tool receives whatever argv the target's implementation builds.

Some targets do both. `EsLint` passes its glob patterns through to ESLint as
arguments, because ESLint expands globs itself. `BiomeCheck` passes each glob's
static directory prefix, because Biome walks paths rather than expanding
patterns. `Vitest` passes its config path but lets Vitest find the test files.
The declared inputs still control the key in all three cases.

## Measurement is revalidated, not assumed

The planner measures a target's declared inputs once and derives the target's
content key from that measurement. The executor takes the measurement again
before it acts on the key: before a cache lookup and before execution, again
after a cached entry's outputs are measured, and again after a successful
execution. Paths and per-file digests are compared, not only how many files
matched.

A declared input that changed, or that can no longer be read, fails the target.
Dependents are blocked, nothing is published to the cache, and every other target
still runs. The alternative, trusting the plan's measurement, would answer a hit
under a key that no longer describes the tree, or publish a result under one.

See [Caching](../workspace/caching.md#inputs-are-revalidated-not-assumed) for
the window this closes and the one syscall-level race that remains.

## Next

- [Dependencies](dependencies.md)
- [Caching](../workspace/caching.md)
- [Writing target definitions](../extending/writing-targets.md)
