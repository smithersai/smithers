---
title: "Caching"
description: "How a target's content key is built, what the result cache stores, when a lookup is admitted, and what re-keys a target."
---

Every target gets a content key. The executor looks the key up before running a
cacheable target and stores the result after a green run.

Filegroup follows this same contract: the first run stores success, and an
unchanged subsequent run reports a cache hit. Changing a member's content
changes the key. A hit does not restore files; Filegroup only describes inputs.

## The content key

The planner builds four fields of key material for each target, encodes them
deterministically, and takes the sha256 of the encoding.

| Field          | Contents                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `body`         | The target's flow tag, target id, schema identity, declared output roots, and `EXECUTION_FORMAT`                       |
| `inputs`       | The ambient identity, the canonicalized attrs, the expanded declared inputs, and the dependency labels with their keys |
| `layers`       | A catalog-declared layer identity list                                                                                 |
| `capabilities` | A catalog-declared capability list                                                                                     |

### The encoding is injective

Key material is encoded into a type-tagged, length-delimited byte string, and
the sha256 of that string is the key. Object keys sort by UTF-16 code unit, so
equal material hashes identically on every host.

Every form carries a distinct tag, so no two values of different types can
collide: `null`, `undefined`, `true`, `false`, a finite number (with `-0`
distinct from `0`), a string, an array, and a plain object are all encoded
differently, and every variable-length form carries its own length so a string
cannot be made to look like a nested structure.

The encoding fails closed. A cycle, a non-finite number, a bigint, a symbol, a
function, an accessor property, a symbol-keyed or non-enumerable own property, a
sparse array, and any object whose prototype is neither `Object.prototype` nor
null all raise a `KeyMaterialError` and fail the plan. This replaced a
`JSON.stringify` of a canonical form that mapped `undefined` to a sentinel
string, `NaN` and `Infinity` to `null`, and a revisited object to `"<cycle>"`.
A legitimate attr value could also produce each of those, so two different
targets could share one key.

A frozen value whose members are all primitives or frozen values cannot
change, so its encoding is kept by identity and reused the next time any key
names it. The planner freezes the file rows of each declared input, which every
target declaring that input shares; their bytes are encoded once per
invocation instead of once per target. A reused encoding is byte for byte what
encoding the value again would produce, so keys are unchanged.

Two substitutions happen inside `inputs.attrs` before hashing:

- A target reference becomes `{_tag: "Target", key: <dependency key>}`. A
  dependency's key change therefore re-keys its dependents, transitively.
- A declared input becomes `{_tag: "File" | "Glob" | "GitDiff", digest: <digest>}`.
  The pattern text and path never reach the key directly; only the content
  digest does.

`layers` and `capabilities` are hand-maintained tables in the planner:

| Target             | `layers`                   | `capabilities`                      |
| ------------------ | -------------------------- | ----------------------------------- |
| `PnpmWorkspace`    | `["package-manager:pnpm"]` | `fs:read`, `fs:write`, `proc:spawn` |
| `LlmLint`          | `["model:<model attr>"]`   | `git:diff`, `model:call`            |
| `Clean`            | `[]`                       | `fs:delete`                         |
| `Dev`, `ToolBuild` | `[]`                       | `proc:spawn`                        |
| Everything else    | `[]`                       | `fs:read`, `proc:spawn`             |

Under a declared [Nix environment](../concepts/environments.md) every target
whose capabilities include `proc:spawn` also carries `nix:<store hash>`: the
32-character hash of the closure its tools resolve from. The hash comes from
the resolved store path, not from the flake's text, so two flakes that
evaluate to one closure share keys and one flake evaluated by two nixpkgs
pins does not.

Deriving both lists from the real flow graph and its resolved layers, instead of
maintaining them by hand, is an open design question.

### Executable and environment identity

`PACKAGE.ts` execution keys the selected executable's resolved path and content
SHA-256, as well as each declared tool reference's resolution and executable
bytes. Changing the bytes behind a fixed version string causes a miss. Before a
target runs, the executor resolves each tool again and compares its bytes with
the planned digest. Within one run it re-reads a file only when its device,
inode, size, mode, mtime or ctime changed, or when its last change is less
than a second older than the previous read, so many targets over one large
binary hash it once. Nanosecond timestamps are compared; an unreadable stat
always falls back to hashing the bytes and discards the remembered digest.
Workspace-local executable paths stay relative; host installations retain their
absolute paths.

The same allowlisted child environment used for execution supplies inherited
values such as `PATH`, `CI`, and SDK selection, with declared `env` and Nix
overrides applied. Its values enter key diagnostics as a digest. Unrelated
parent variables and withheld cache credentials do not enter it. Changes to
host `PATH` can therefore prevent cache sharing between checkouts. Dynamically
selected subprocesses and libraries still need declared tool/input dependencies.

### Implementation identity

The ambient `implementation` field is a digest of the loaded, shipped source
trees: the CLI, target catalog, build runtime, execution libraries, and pinned
runtime dependencies. Logical root names, relative file names, and file bytes
enter the digest; absolute paths never do. Two checkouts of the same sources at
different locations therefore agree on the key and can share a cache.

`Target.Metadata.implementationDigest` is not persistent key material. It
includes process-local entropy for any callback not declared with
`Node.capture`, because JavaScript cannot inspect an ordinary closure's captured
values. It distinguishes target implementations within one process, but would
force every target to miss in the next process.

The ambient fingerprint covers the complete shipped implementation rather than
only the declared callback: helpers, action layer implementations, and the
executor's own admission logic all re-key every target when any source byte
changes. There is no salt to remember to bump. `EXECUTION_FORMAT` remains for
deliberate semantic breaks.

## What re-keys a target

- Editing any file a declared `file()` or `glob()` matches.
- Adding or removing a file a `glob()` matches. The glob expands to a sorted file
  list, and the list plus per-file digests are hashed.
- Changing the content of the diff a `gitDiff()` names. The digest is the sha256
  of the `git diff --binary <base>...HEAD` patch text.
- Changing any attribute value, including `cwd`, a boolean flag, or a tool
  choice.
- Any change to a transitive dependency's key.
- For `LlmLint`, changing the `model` attribute, which also changes `layers`.
- Any change to the bytes of the shipped `cli/src`, `targets/src`, or `src`
  sources, through the ambient implementation fingerprint.
- For a test, type-check, lint, build or format target, any change to the
  bytes of an installed tree above the directory its tool starts in or above a
  file it declares, or to the `package.json` of the directory its tool starts
  in.
- Under a declared Nix environment, any change to the closure: an edit to the
  flake, its lock, or the expression file that changes the store path.

Two things deliberately do not re-key a target: the workspace's absolute path,
and the resolved cache directory name. See
[Configuration](configuration.md#why-the-directory-is-not-key-material).

## Cacheability

A target is **non-cacheable by default**. `Target.make` takes an explicit `cache`
boolean or a function of decoded attrs. This fails safe for custom targets and for
catalog targets that invoke an external tool whose complete toolchain identity is
not yet key material.

| Target                                                           | Cacheable                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DocsParity`, `Filegroup`                                        | Always; each is a bounded in-process check over declared content                                        |
| `PackageJsonCheck`                                               | Only with no generated fields; generated-field checks consult host-local state                          |
| `GithubCiGen`                                                    | In `check` mode; never in `write` mode                                                                  |
| `Vitest`, `NodeTest`, `Typecheck`, `EsLint`, `Dprint`, `TsBuild` | After a confined run; see [Results reused with evidence](#results-reused-with-evidence)                 |
| `ToolBuild`, `NodeTest`                                          | Also when the declaration sets `cache: true`                                                            |
| Rules the executor runs natively                                 | As their rule policy says; `Shell.Test` caches in `execute` mode                                        |
| `Shell.Test` with `observe`                                      | From what its run read; see [Results reused from what a run read](#results-reused-from-what-a-run-read) |
| Every other catalog target                                       | Never                                                                                                   |

Mutation, long-lived processes, model calls, and external publication are never
cached. `cache: true` on a `NodeTest` is the declaration's assertion that `srcs`
and `deps` cover everything it reads; a result stored on that assertion needs no
confined run and stays in the local tier unless one confined it. A `testSuite`
runner names only directories, so `cache: true` requires at least one declared
`srcs` input or dependency; runner directories alone cannot re-key a cached
verdict.

A declared [Nix environment](../concepts/environments.md) enters keys through
the tool environment, but does not by itself make these targets cacheable.

A result produced without enforced confinement is stored in the local tier
only; it never publishes to a remote cache.

### Results reused with evidence

A test runner, a type checker, a linter, a formatter and a build each start a
program that can read any file it can reach. The declared inputs key the result,
so a read the declaration does not name leaves the key unchanged while the
verdict moves. A stale green test is the worst thing a build cache can return.
`Vitest`, `NodeTest`, `Typecheck`, `EsLint`, `Dprint` and `TsBuild` are
therefore reused on one condition: the run that produced the result was confined
to what its key covers. A build's declared outputs are stored with its result
and put back on a hit.

**What the key covers.** Beside the declared inputs, the dependency keys, the
lockfile, the package manager, the runtime and the declared environment:

- The bytes of every installed tree the run can read: each `node_modules`
  directory above the directory the tool starts in, and each one above a file
  the target declares, which is where that file's imports resolve. The lockfile
  says what an install should contain; this measures what is there, so a package
  patched in place or a binary replaced under one version re-keys the target.
  The test runner, its plugins, the compiler and the lint rules all live there.
  The tree of a package the target declares no file of is not shown to the run.
- The `package.json` of the directory the tool starts in, which the package
  manager and the tool resolve the package from.
- For `Vitest`, the bytes of each program its `tools` declares, which the
  suite starts by name. A confined run is shown those programs and the system's
  own; any other program on the host's `PATH` fails with
  `<name> is not declared: declare it in tools`. See
  [Programs the suite starts](../reference/targets/vitest.md#programs-the-suite-starts).
- For `Dprint`, the bytes of each plugin its configuration pins, from dprint's
  own cache outside the workspace. The run is shown those files and nothing else
  of the cache, through a link where dprint looks for its cache. A plugin dprint
  has not fetched, a configuration that extends another or is not plain JSON,
  and a plugin that is not a remote `.wasm` pinned by its checksum each leave the
  result unreused, with the reason.

A tree is measured as units: its `.bin` directory, each child of a pnpm store
(`.pnpm/<id>`), and each other entry whose name does not start with a dot. A
link is recorded as its target text, never followed, so a workspace package
linked into the tree contributes a link; its sources are the consumer's declared
inputs. Each unit's digest is remembered in
`<cacheDirectory>/plan/installed-trees.json` beside the status of its entries
(size, mode, inode, device, both nanosecond timestamps) and read again only when
one changed. On this repository the tree is 112,882 files and 2.5 GB: 7.3 s to
read once, 0.8 s on every later plan. A tree that cannot be measured whole makes
the contract incomplete, and the result is never reused.

**What a confined run proves.** The run sees its declared inputs, its
dependencies' declared outputs, the keyed units of each installed tree, and the
host paths every confined tool sees. Nothing else under the workspace exists for
it, so a file the declaration does not name is missing, the tool fails, and a
failed run stores nothing. The network is closed.

The mechanism is bubblewrap with a scratch layer: a write the declaration does
not name lands in a private layer and is gone when the run ends. A tool that
leaves files beside its inputs (a compiler's declaration sidecar, a bundled
config, a coverage report) therefore runs against exactly its declared reads,
and none of those files reaches the workspace. The layer changes what a write
does and never what a read sees. A tool's own state under a dot name inside an
installed tree (`node_modules/.vite`) is not shown to the run.

A run that declares more files than bubblewrap can bind one at a time (it
accepts 9,000 arguments, and each file takes three) is given one private
directory instead. It holds each declared file at its own path and is mounted
at the workspace root, so the run sees what the binds would have shown it.
Without the scratch layer the directory is read-only and its files are hard
links to the workspace's own, or copies on another filesystem. With the layer
its files are copies with their own modes: a write to one, or beside one, stays
in the directory and goes with it, so a test that copies a declared fixture and
edits its copy runs as it does outside. The directory is in the host's temporary
directory, which no confined run can see, and it is removed when the run ends,
also when the program is killed.

**How a run gets its evidence.** It depends on what the workspace declares for
`S.Sandboxes({ default })` and on what the host has:

| Workspace                                  | Run                                                                                                                | Stored               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Confines its build, host has `bwrap`       | Confined under the scratch layer. A failure is the target's failure                                                | A green run          |
| Confines its build with seatbelt or Docker | Confined as declared, without the layer                                                                            | Nothing              |
| `S.Sandbox.None()`, host has `bwrap`       | One confined attempt. Green: that run is the verdict. Red: the tool runs again unconfined, and that is the verdict | A green confined run |
| `S.Sandbox.None()`, host has no `bwrap`    | Unconfined, as declared                                                                                            | Nothing              |

Only a run under the scratch layer is evidence. Without the layer an installed
tree is granted whole, and a tool's own state inside it is readable and in no
key. For the same reason a tree that is itself a link, or that holds a link out
of the workspace, stores nothing: it can only be granted whole. A tree installed
after the plan is in no key and is not shown to the run at all.

A workspace that turned build confinement off keeps every verdict it had: a
suite that passes today still passes, and it is cached once it also passes
confined. A red attempt that the unconfined run turns green prints one line
naming the paths the confinement closed, and its output is kept in
`<cacheDirectory>/evidence/<id>.json`, with the build of Smithers build that
made it. The same build does not repeat the attempt for 24 hours unless the
declaration changes, so a suite that cannot run confined costs one extra run a
day. Another build attempts it once more at its first run, so an upgrade that
fixes the confinement is not kept waiting. A `Vitest` attempt runs with
`--bail=1`: an attempt that is going to be discarded stops at its first
failure.

A host with no scratch-capable mechanism (macOS, or Linux without `bwrap`) stores
nothing and still answers hits a capable host stored.

**What a confined verdict means.** A green confined run is the verdict, in both
modes, and it differs from an unconfined run in two ways a declaration has to
know about:

- A file the run writes outside its declared outputs is discarded: a coverage
  report, a JUnit file, a snapshot. None of these targets declares outputs, so a
  hit restores none either.
- A file the declaration does not name does not exist for the run. A case that
  is skipped when a file or a host tool is missing is skipped, and the suite can
  pass without it. A coverage threshold catches that; nothing else does.

A target whose run must leave files behind, or whose cases depend on files it
does not declare, sets `cache: false`. It then runs exactly as the workspace
declares, with no confined attempt, and is never reused.

**What a stored result carries.** A dependency's key names its declaration, not
the bytes its run left on disk, and a dependency that is not itself confined can
leave different bytes under one key. The result records the measured content of
every dependency output the run could read, and it answers only while those
outputs still measure the same.

**What keeps a result from being reused.** Each is a test in
`build-cli/test/CacheEvidenceExecution.test.ts`, run under real bubblewrap:

- A changed source, test file, config, lockfile, tool byte or installed
  package: the key changes, the target runs.
- A failed run: nothing is stored.
- A run that reads an undeclared file: confined it fails, so nothing is stored;
  the unconfined verdict is reported and the target runs every time.
- A missing tool: the run fails.
- An installed tree that changed after the plan measured it: the trees are
  measured again before the result is stored. See
  [An installed tree stays the tree a plan measured](#an-installed-tree-stays-the-tree-a-plan-measured).
- A dependency output that changed under an unchanged key, an entry stored
  without evidence, a run whose `PATH` is not the one the plan fingerprinted:
  each is a miss.

**What declares a target out.** `cache: false`, `sandbox: "none"`, an opened
network, `services`, `Typecheck` in build or incremental mode, and `EsLint` or
`Dprint` with `fix: true` are never reused. The planned node carries the reason as
`uncachedBecause`.

[Affected selection](affected.md) does not change. A result that is never
stored still has to rerun, so a file no declaration names selects every
tool-backed target in its package, as before
(`build-cli/test/AffectedEvidence.test.ts`).

### Results reused from what a run read

A shell command can read any file it can reach, and nobody can list those files
for it. `Shell.Test` with `observe: true` records what a run reads instead:

```ts
S.Shell.Test({
  shell: "npm test",
  sandbox: "none",
  observe: true,
  data: [S.glob("//**")]
})
```

The run happens under a system-call trace. The trace names every path the run
looked at, inside the workspace and outside it: each file it opened or asked
about, each directory it listed, each path it looked for and did not find. The
stored result holds those paths and what was at each one. The next run is a
cache hit when every one of them still holds the same thing. A change to any
other file in `data` does not run the target again.

| What changed                                      | Why the target runs again                                   |
| ------------------------------------------------- | ----------------------------------------------------------- |
| A file the run read                               | Its content, or whether it can be executed, differs         |
| A new file in a directory the run listed          | The directory's names differ; a glob lists where it matches |
| A path the run looked for and did not find        | It now exists                                               |
| A symbolic link on the way to a file              | Its target differs                                          |
| The command, `env`, an `inheritEnv` value, a tool | The declaration's key differs                               |
| A variable `observe.env` names that the run used  | Its value differs                                           |

The line of a target that runs again names the first difference:

```text
//:test  runs again: packages/a/value.js changed
```

The structured summary carries the same text on the target's row as
`notReused`, and `--results-file` writes it, so a program that reads a run can
say which file made a step run again.

A file a step before it left is named with that step: `deps/built.txt, which
//:build left, changed` says the build ran again and left other bytes, where
`src/a.txt changed` names a file of the workspace.

A record holds every path its run read, and a change to any of them makes the
run happen. For a target on a machine, the files a fresh checkout holds are
compared first: they are what a commit changes. Then come the other paths of
the workspace, smallest first, and the tools and installed packages last. So a
run that has to happen is known before an installed package is read. When
several paths changed, the line names the first one found.

**Where the time went.** A target's row also carries `parts`: the milliseconds
its run spent on each part, as `ms`, and the CPU time of each part, as `cpuMs`,
on Linux.

| Part      | What it times                                               |
| --------- | ----------------------------------------------------------- |
| `machine` | Making the machine of the target's job, in its first target |
| `putBack` | Putting back what earlier steps left                        |
| `check`   | Comparing the stored records with the files as they are     |
| `step`    | The command, under the tracer when its reads are recorded   |
| `reads`   | Reading the trace and measuring every path the command read |
| `keep`    | Keeping what the command left                               |
| `store`   | Storing the record                                          |

The summary itself carries the parts of the run that belong to no target:
`start`, from the start of the program to its command; `plan`, loading the
workspace and deciding what to run; `answer`, finding the targets answered
without running; and `machinesRemoved`. The CPU time is the build's own and
that of every process it waited for, so it is exact while one target runs at a
time. `--results-file` writes both:

```json
{
  "parts": { "ms": { "start": 2690, "plan": 480, "answer": 150, "machinesRemoved": 1120 } },
  "results": [
    {
      "label": "//:test",
      "status": "ran",
      "durationMs": 14970,
      "notReused": "package.json changed",
      "parts": {
        "ms": { "check": 450, "step": 11640, "reads": 2340, "keep": 140, "store": 130 },
        "cpuMs": { "check": 720, "step": 12220, "reads": 2570, "keep": 380, "store": 70 }
      }
    }
  ]
}
```

**The declaration's key.** The records are stored under a key of the
declaration alone: the command, the environment, the executables it names, the
platform and the labels it depends on. No file is in it. A run sees only its
declared environment and a few host variables (`PATH`, `HOME`, the temporary
directory), and every one of them is in the key by value, so no variable
outside the key reaches it but those `observe.env` names. Four records
are kept for one declaration, so a fresh checkout and a tree a run has already
been through each find their own.

**What the run wrote.** A path the run made before it looked at it is its own
product and never an input. Two threads' calls can overlap in a trace: a call
that found a name the run made where nothing was (a directory, a link, a new
file) and that ended after the making began came after the making. So is what the run wrote in a directory it then
moved into place, as a package manager fills a directory under a temporary name
and renames it into its cache. So is a file the run opened to read, making it if
need be, in a directory the run itself made with `mkdir`: the directory held
nothing when it was made, as the manifest `zig build` opens in the cache
directory of a fresh checkout shows. A directory the run then removed, moved,
or moved another directory onto is no longer one it made. A path it found missing and then made, or opened to write, matches when
it is missing again or still as the run left it. A file the run read and then
rewrote is compared with what the run wrote, because what it held before is
gone. A new mode or time the run gave a file counts as such a write. A step is therefore taken to give the same verdict when it runs again on
files exactly as it left them.

**Steps that leave files for the next step.** A CI job installs, builds and
then tests in one checkout, and each step reads what the one before it wrote.
Declare each step as an observed test that depends on the step before it:

```ts
const install = S.Shell.Test({ shell: "npm ci", sandbox: "none", observe: true, data: [files] })
const build = S.Shell.Test({ shell: "npm run build", sandbox: "none", observe: true, data: [files, install] })
const test = S.Shell.Test({ shell: "npm test", sandbox: "none", observe: true, data: [files, build] })
```

What a step left is kept, so a step after it can run without it. After a run,
the files, directories and links the run wrote that are still there, in the
workspace and under the temporary directory, are packed into one archive in
`<cache directory>/kept`. Nothing is packed for a step that no declared target
waits for: its files would be put back for nobody. The build decides for all the steps at once, before
the first target starts, which of them are answered from their records. When
one that is not answered is about to run, what each answered step it waits for
left is put back first: what the run removed is removed, and its files are
unpacked where they were.

The files are put back as if the step had just run. An archive holds the
modification times of the run it was kept from, which are older than a checkout
made today, and a tool that compares times, as `make` does, would find every
output out of date. So the times move together: the newest file gets the time
of the moment it is put back, every file is newer than what was there before,
and the step's files keep the order the step wrote them in. A step that took
longer than putting its files back takes keeps that order and not the gaps
between its files.

| Tree                                                      | What runs                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| Every step would read what it read before                 | Nothing, and nothing is put back, in a fresh checkout too     |
| Only `test` reads a changed file                          | `test`, after what `install` and `build` left is put back     |
| Only `build` reads a changed file                         | `build`, after what `install` left is put back, then `test`   |
| Only `install` reads a changed file, and writes as before | `install`; what `build` left is put back, and `test` is a hit |

A path a step read that an earlier step wrote is recorded with that step. It
matches when it holds what the run read there. In a fresh checkout it is
missing, and it matches while the step that wrote it is itself answered from the
record this run read it under: that step would write it again as it was.

The kept files stand for a run only while everything else the run left is as
it left it. What a run wrote outside the workspace and the temporary directory,
such as a program it installed in the home directory, is recorded with what was
there, and is checked before the files are put back. What a locked install
fetched into its own cache is left out: a package manager fills its cache again
when a file is missing. Four things are never kept, and the step then runs
again when a step after it runs:

| What the run left                               | The line                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A link to a file it wrote outside the workspace | `what it left is not kept: <link> is a link to <path>, which it wrote outside the workspace` |
| A file under `.git`                             | `what it left is not kept: it wrote <path>, in the repository's own store`                   |
| More than 300,000 paths or 2 GiB                | `what it left is not kept: it left too much to keep`                                         |
| More than 2,000 files outside the workspace     | `what it left is not kept: it left too many files outside the workspace to keep`             |

Keeping needs `tar` on the host. When the kept files cannot be put back (an
archive cut short, a host without `tar`), the step itself runs in their place.
A step that runs because a later step needs what it left, and it is not kept,
says so:

```text
//:install  runs again: a step after it runs, and may read what this one leaves
```

When it is kept and cannot be put back, the line says what stands in the way:

```text
//:install  runs again: a step after it runs, and what this one left cannot be put back: /opt/tools/bin/tool, which it left outside the workspace, is not as it left it
//:install  runs again: a step after it runs, and what this one left cannot be put back: the files kept for it are not in the cache directory
```

The archives of a declaration's four records are the only ones kept; an older
one is removed with its record. A CI machine that carries the cache directory
from one run to the next carries `kept` with it.

On a host that cannot record reads, an observed step another target waits for
runs every time, and only the last step of a chain is reused, from its `data`.

**A locked install may use the network.** A run that opens a network
connection stores nothing, with one exception: a package manager told to
install exactly what a lockfile pins, and the processes it starts. What it
fetches is fixed by the lockfile, which the run reads, so its result does not
depend on what the network answers.

| Command                                                            | Counts as locked                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `npm ci`                                                           | Always                                                              |
| `pnpm install`, `bun install`                                      | With `--frozen-lockfile`; `pnpm ci`, `bun ci`                       |
| `yarn install`                                                     | With `--frozen-lockfile` or `--immutable`                           |
| `uv sync`, `uv run`                                                | With `--locked` or `--frozen`; `uv run` until it starts the command |
| `pip install`                                                      | With `--require-hashes`                                             |
| `go mod download`, `cargo fetch --locked`, `deno install --frozen` | Always                                                              |

`npm install`, `pip install -r requirements.txt` and every other command that
may resolve a version at run time still store nothing when they connect.

**A build may fetch what its lockfile pins.** `cargo test` downloads the crates
`Cargo.lock` names, and `go test` the modules `go.sum` names. The tool's own
connections do not stop the result from being stored when the run read that
lockfile, in the directory the tool started in or one above it, and nothing
wrote it afterwards. A tool that makes or changes its lockfile chose a
version, and that run stores nothing.

| Tool    | Commands                                                                                         | Pinned by    | Chose a version when it wrote                  |
| ------- | ------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------- |
| `cargo` | `build`, `check`, `test`, `doc`, `run`, `bench`, `rustc`, `rustdoc`, `fetch`, `metadata`, `tree` | `Cargo.lock` | `Cargo.lock`                                   |
| `go`    | `build`, `test`, `vet`                                                                           | `go.sum`     | `go.sum`, `go.mod`, `go.work.sum` or `go.work` |

Only the tool itself is covered. A compiler, a build script or a test it
starts that connects still stores nothing, and so does the program `cargo run`
becomes. `cargo install`, `cargo update`, `go get` and `go run` choose
versions and are not covered.

**What cargo reads for its own bookkeeping is no input.** Under the commands
above, cargo opens the repository's git store (`.git/HEAD`, `.git/index`) to
list a package's files, which tells it whether a build it kept is older than
a source. It also keeps what it asked the compiler in `.rustc_info.json`,
which it checks against the compiler before use and writes with its entries
in another order at every run, and in its home it notes when each downloaded
crate was last used, in `.global-cache`. None of the three is recorded when
cargo itself reads it, so a `cargo doc` step is reused at a commit that
changes nothing else it read, and the `cargo test` after it does not run
because the step before it left those notes with other bytes. The directories cargo lists and the sources the compiler reads are
recorded as always. A build script or a test that reads `.git` did read it,
and so did `cargo package`, which writes the commit into what it packs.

**What pnpm reads for its own bookkeeping is no input either.** pnpm 11.20 to
11.25 notes in `node_modules/.pnpm-workspace-state-v1.json` when it last
checked `node_modules` against the lockfile and the manifests, and reads the
note before a script only to skip that check when none of them changed since.
A script with no install before it installs first and writes the note again
with the time. The rest of the note copies settings and manifests the script
reads too. So under any `pnpm` command the note is not recorded when pnpm
itself reads it, and the script after one that wrote it is reused when nothing
else it read changed. A program pnpm starts that reads the note did read it.

**Variables that differ from run to run.** A CI run is given the commit it is
for, a run id and a run number, and each is another at the next run. In the
key, each would make every run a new declaration. Left out of everything, a
run that reads one would be answered with the result of another commit.
`observe: { env: [...] }` names such variables:

```ts
S.Shell.Test({
  shell: "npm test",
  sandbox: "none",
  observe: { env: ["GITHUB_SHA", "GITHUB_RUN_ID"] },
  data: [S.glob("//**")]
})
```

Each reaches the command with its host value, as with `inheritEnv`, and is no
part of the declaration's key. No trace shows a process reading its
environment: every shell copies all of it when it starts. So a record holds a
variable's value when the run shows it could have used the variable:

| What shows it                                                             | Example                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| The variable's name in `shell`                                            | `echo "$GITHUB_SHA"`                           |
| Its name in a file of the workspace the run read that git does not ignore | A test that reads `process.env.GITHUB_SHA`     |
| Its value in what the run printed                                         | `printenv`, a tool that logs the commit        |
| Its value in a file the run wrote and left                                | A version file, a report with the commit in it |
| Its value in the arguments of a program the run started                   | `git show` with the commit                     |

The record answers a later run only while each of those variables holds the
same value. The line of a target that runs again says which one does not:

```text
//:test  runs again: the variable GITHUB_SHA has another value
```

A name in a file git ignores, such as an installed package or a build product,
does not count on its own. Test runners and package managers hold the names of
many variables they act on only when asked for a report, and then the value is
in what they wrote. A commit id is also looked for by its first seven
characters. A value shorter than six characters, such as a run attempt of `1`,
is in every output by chance, so only its name shows a run used it. What a
locked install fetched is not searched: a lockfile fixed it. A record holds a
digest of each value, never the value.

A program that builds a variable's name out of pieces and uses the value only
to decide something, without printing or writing it, shows none of this. Name
the variable in `inheritEnv` for such a command: its value is then part of the
key at every run.

`observe: { readAsData: [...] }` names files the run reads as data, from the
workspace root: a file, or a directory with all it holds. A variable's name in
one of them does not show the run used the variable, as a CI's workflow files
name the variables the CI sets and a check that reads them uses none. Each is
still an input: the target runs again when one it read changes.

```ts
S.Shell.Test({
  shell: "node scripts/check-workflow-pins.mjs",
  sandbox: "none",
  observe: { env: ["GITHUB_SHA", "GITHUB_RUN_ID"], readAsData: [".github/workflows"] },
  data: [S.glob("//**")]
})
```

On a host that cannot record reads, every variable `env` names is part of the
key, as with `inheritEnv`.

**The same variables for a test held to its files.** A test in the read sandbox
is not observed: `data` names every file of the workspace it can read. `given`
names the variables for it:

```ts
S.Shell.Test({
  shell: "npm test",
  sandbox: { network: true },
  given: { env: ["GITHUB_SHA", "GITHUB_RUN_ID"], names: ["GITHUB_EVENT_PATH"] },
  data: [S.glob("//packages/a/**")]
})
```

Each variable of `env` reaches the command with its host value. The values are
part of the key only when the test could read one: when `shell`, or a file
`data` names, holds the name of one of the variables or one of `names`. `names`
lists other names that tell as much, such as a variable the command works out
from one of them. When a name is found, every value is in the key, and the test
runs again at each new value. When none is found, the key is the same at every
value: the result is reused at another commit, from the remote cache too.

The values are always in the key where the declared files are not all the test
can read: with `sandbox: "none"`, with a dependency, whose outputs it may read,
and with an `S.link` among `data`.

**What is left out.** A path through a link the kernel makes for the run's
own process, such as `/proc/self/cwd/x`, `/proc/<pid>/root/...` or
`/dev/fd/3/x`, is recorded as the file it leads to for that process. What is
left under `/proc`, `/sys` and `/dev` is the machine, not files. The workspace
cache directory is the build's own. `observe: { ignore: [...] }` names
more: a file, or a directory with all it holds, from the workspace root,
absolute, under the home directory as `~/...`, or under the run's temporary
directory as `$TMPDIR/...`. Use it for what a tool writes on every run and never
reads to decide its result, such as a log directory, or the compiled code Node
keeps in `$TMPDIR/node-compile-cache`.

`observe: { quiet: [...] }` names words that mark a question the command asks
for itself. A program the run starts with one of them among its arguments, and
every program that one starts, reads nothing the record holds; what it writes
is the run's. A wrapper that asks git which commit is checked out, where no CI
runner said, and hands it to the command in `GITHUB_SHA` marks that `git`, as
in `git -c ci.asks=commit rev-parse HEAD` with `quiet: ["ci.asks=commit"]`. The
command is then reused at the next commit as it is on a runner, and a `git` the
command starts itself is recorded as any program is.

**When nothing is stored.** A green run stores nothing when what it read cannot
all be known, and says why on its own line:

| Reason                                                                     | What happened                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `it opened a network connection (uv to 151.101.0.223 port 443)`            | What a network answers is in no record. The line names the program and the first address     |
| `it reached a program outside the run ...`                                 | A daemon reads files this run's trace does not show. A server the run starts itself is in it |
| `it changed its view of the file system`                                   | After `mount`, `pivot_root` or `chroot`, a path no longer names what the trace says          |
| `<path> changed while it ran`, `was removed while it ran`                  | Something else wrote a file the run read, so what the run saw can no longer be measured      |
| `its trace ...`                                                            | A line of the trace could not be read in full                                                |
| `its trace does not say where /proc/self/fd/3/x led`                       | With strace, a path below a descriptor is followed only for a call that opened a file there  |
| `it started /usr/bin/ping, which needs rights its jail takes away`         | See below: it ran again with no jail and no tracer, and that run is the verdict              |
| `<path> leads through a link of a process ...`, `... goes back up ...`     | A link of the workspace, or a `..`, leads into `/proc/self`, which only the run could follow |
| `it read more paths than one record holds`                                 | The record would not fit one cache entry: 15 MiB or 499,000 JSON members, about 100,000 paths |
| `it passed, but failed while its reads were recorded`                      | See below                                                                                    |
| `its recorded run failed and its plain run passed; it runs unrecorded ...` | See below: the run after such a one, of a target another waits for                           |
| `a step after it may read what it leaves, and its reads are not recorded`  | The host cannot record reads, and another target waits for this one                          |

A program whose file asks for rights (set-user-id, set-group-id, a file
capability, as `ping` has) gets none in a traced run, nor in the jail that gives
a machine its own `/tmp`: both give the run no new privileges. The trace names
each such program the run started. The target then runs again with no jail and
no tracer, in the tree the traced run left, and that run is the verdict, pass or
fail. Nothing is stored, and until the declaration changes it runs that way
only. Where no run of the build can have the rights, the target fails and says
so: the build itself has no new privileges, or another machine of the build
has the host's `/tmp`.

A tracer also changes what a program that traces another can do. A traced run that fails is
therefore followed by an untraced run, and the untraced run is the verdict. When
it passes, nothing is stored and the declaration is not traced again for a day
by the same build of Smithers build with the same recorder; until then it is
keyed by its `data`. Another build, or another recorder, records it once more
at its first run: the failure may have been the recorder's or the build's, and
an upgrade may have fixed it. A target that another target waits for
cannot be keyed so, because nothing says what it leaves: it runs every time
until then, and its line says when the recording is tried again:

```text
//:install  not cached: its recorded run failed and its plain run passed; it runs unrecorded until 2026-11-21 02:21 UTC
```

A run that opened a network connection, or reached a program outside the run,
stores nothing whether its reads are recorded or not. Recording it again would
cost time and store nothing, so for a day after such a run the declaration runs
without the tracer. It still runs every time, and its line says why:

```text
//:install  not cached: it opened a network connection (npm to 104.16.4.34 port 443), when its reads were last recorded; they are recorded again a day after that run
```

The first run after that day is recorded again, and is stored when it no
longer reaches outside.

**Hosts.** Observation needs Linux. On x86_64 and aarch64 with Linux 5.19 or
newer, a run is recorded by `smthrs-observe`, a program this package holds: a system-call
filter hands each file-system call to it, only the thread that made the call
waits while the line is written, and the call then goes on in the kernel. A
process that sets a signal handler a signal could cut a waiting call short
through is also traced, so a signal never cuts short a call it would not cut
short unrecorded. Elsewhere on Linux (an older kernel, a host where the
program cannot listen, a container without `CAP_SYS_PTRACE`, where
Docker's default profile refuses it `pidfd_getfd`) a run is recorded by
`strace` 5.3 or newer, which stops the traced thread at each file-system call;
`SMTHRS_OBSERVE_WITH=strace` asks for it anywhere. click's pre-commit hooks,
83,000 such calls, take 1.6 s recorded by `smthrs-observe` and 2.6 s by
`strace`, against 1.2 s unrecorded. Under `strace` the run is refused
`io_uring`, as it is in a container, because a read submitted through a ring
is in no trace; under `smthrs-observe` a ring request that names a path makes
the run unrecorded, with the reason. A port a recorded process closes is free
again at once, as it is unrecorded, so a program that listens on it again
finds it free. A recorded run ends when its command
ends: a process the command left running is stopped a second later, as a
sandbox stops it. On macOS and Windows, where neither recorder can run, or
where the host forbids it, the target is keyed by its `data` as any other
`Shell.Test`, and one line says why:

```text
smthrs: reads are not observed on this host: strace is not installed; a target that asks for it is keyed by its declared inputs
```

In a Docker container started without `CAP_SYS_PTRACE` and with no `strace`,
the line names what the container refused and what lets it record:

```text
smthrs: reads are not observed on this host: smthrs-observe cannot run here: this machine refuses pidfd_getfd, which reads a socket a step binds: Operation not permitted; a container allows it with CAP_SYS_PTRACE, and strace is not installed; a target that asks for it is keyed by its declared inputs
```

`observe` requires `sandbox: "none"`, because a confined target is already held
to its declared inputs. It cannot be combined with `shards` or `services`. Its
results stay in the local cache, as every unconfined result does.

`build-cli/test/ObservedReadsExecution.test.ts` runs real commands under the
real tracer: an unchanged tree, a changed file, a new file in a listed
directory, a path that was missing and now exists, a command that fails only
when traced, and a command that reaches a server outside the run.

### A machine for the steps of a job

A CI system starts every job on a machine of its own: a fresh checkout, an
empty home directory, an empty temporary directory, and nothing another job
did. Steps written for that pass there and can fail in one shared tree: one
job edits a file another job checks, or two jobs each expect `~/.cache/tool`
not to exist. `machine` gives the targets of a job the same in one build:

```ts
const install = S.Shell.Test({ shell: "npm ci", machine: "ci.yml:test", sandbox: "none", observe: true, data: [files] })
const test = S.Shell.Test({
  shell: "npm test",
  machine: "ci.yml:test",
  sandbox: "none",
  observe: true,
  data: [files, install]
})
const lint = S.Shell.Test({
  shell: "npm run lint",
  machine: "ci.yml:lint",
  sandbox: "none",
  observe: true,
  data: [files]
})
```

Targets that name the same machine run in one private copy of the workspace,
one at a time, each after the targets it depends on. `HOME`, `XDG_CACHE_HOME`
and `TMPDIR` name directories of that machine, and `SMTHRS_MACHINE_TMP` names
its temporary directory also for a target that sets `TMPDIR` itself. No other
target sees what they write, and they see nothing another target wrote, in the
tree, the home or the temporary directory. Targets of different machines run
at the same time under `--jobs`.

| What a machine starts with | What it holds                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The tree                   | A fresh checkout: what git tracks, as the working tree has it now, and every other file `.gitignore` does not leave out   |
| The repository             | Its own `.git`: the same commit, branches, tags, remotes and index. Objects are read from the workspace's store           |
| The home                   | Empty, or a copy of the directory `SMTHRS_MACHINE_HOME` names. A version manager on `PATH` is linked where its shims look |
| The temporary directory    | Empty                                                                                                                     |

The cache directory is the build's own and is not copied: `{smthrs:cache-directory}`
in a target's command or `env` names the workspace's cache directory on a
machine too, so what a target keeps there outlives its machine.

An installed `node_modules` and a build's output are in no fresh checkout, so
a machine has neither until one of its targets makes it. A workspace that is
not the root of a git checkout is copied whole, apart from the cache
directory. The tools on `PATH` are the host's.

**A machine is made only for a target that runs.** The build decides which
observed targets are answered from their records before the first target
starts, against what a machine starts with. A build that answers every target
of a machine makes no copy. When one target of a machine runs, the copy is
made, what each answered target before it left is put back in the copy, and
the target runs there. The line says how long the copy took:

```text
smthrs: machine ci.yml:test has a fresh checkout, made in 412 ms
```

A record of a run on a machine names the machine's own paths from the machine,
as in `/smthrs-machine/home/.npmrc`, the directory its machines are kept in as
`/smthrs-machines`, and the copy's paths from the copy's root. It holds no
path of the checkout it was made in, so it answers in another checkout that
restored the cache directory, as a CI machine does between runs.

What a step left in its machine's home or temporary directory is kept with
what it left in the copy, in a second archive beside the first that names each
path from the machine. A machine starts with an empty home and an empty
temporary directory wherever machines are kept, so when a step after it has to
run, the files are put back in all three places: a tool the step installed
under the home, a file it left under `/tmp` for the next step, and what it
wrote in the copy. A build whose machines are kept under `/tmp` and one whose
machines are kept under a home directory keep and put back the same files.

Machines are kept under the user's state directory
(`$XDG_STATE_HOME/smthrs/machines`, else `~/.local/state/smthrs/machines`),
outside the workspace, so a tool that walks up from the copy finds no file of
the workspace. `SMTHRS_MACHINES` names another directory. No part of that path
may be named `.cache`, `.git`, `.hg`, `.output`, `.svn`, `.yarn` or
`node_modules`: Biome skips a project's nested `biome.json` under such a
directory, so a lint that passes in the workspace would fail on the machine,
and the build stops before the first target with that reason. Machines are
removed when the build ends, and what an earlier build left there, or under
`~/.cache/smthrs/machines` where builds kept them before, is removed before the
first target runs. One build at a time uses a workspace's machines.

Every machine stays until the build ends, so the machines of a large repository
can fill the disk. A target on a machine that fails while the disk that holds
the machines is full, with less than 1 GB free or less than 1% of the disk when
that is more, did not fail on its own when the other machines hold more than
its own: its failure says so, names the disk, what the machines hold and
`--jobs`. A target whose own machine holds the most keeps its own failure.

`machine` requires `sandbox: "none"`. A `Shell.Build` on a machine also
declares `cache: false`: what it builds stays on its machine for the targets
there that depend on it, so it always runs. `machine` cannot be combined with
`shards` or `services`.

**`/tmp` is the machine's too, where the host can give it one.** A program
that writes `/tmp/x` names no `TMPDIR`. On Linux, with bubblewrap on `PATH`
and a host that lets a process make a mount of its own, each target of a
machine runs with the machine's temporary directory in place of `/tmp`, so
`/tmp/x` and `$TMPDIR/x` are one file and no other machine sees it. A record
names such a path from the machine, as `/smthrs-machine/tmp/x`. What the build
itself keeps under `/tmp` stays where it was: the entry of `/tmp` that holds
the workspace, the cache directory, the machine, a tool on `PATH` or Node. Where the host
gives no such mount (another system, no bubblewrap, or a container that
refuses it), the targets of every machine share the host's `/tmp`, `TMPDIR`
is still each machine's own, and the build says so once:

```text
smthrs: the targets of a machine share this host's /tmp: bwrap is not on PATH (install the bubblewrap package); TMPDIR is still each machine's own
```

`SMTHRS_MACHINE_OWN_TMP=required` forbids that sharing. On a host that gives
no private `/tmp`, the targets of the first machine to run use the host's, and
a target of any other machine fails with the reason, so no machine ever finds
what another left in `/tmp`. Set it where the machines stand for jobs that
must not meet, as the jobs of a CI on one runner.

`build-cli/test/MachineExecution.test.ts` runs real commands in a real git
checkout: two machines that never see each other's writes, the steps of one
machine in order, an answered step whose files are put back in the copy, and a
build that makes no machine because every target is answered.

### An installed tree stays the tree a plan measured

Some packages write into their own installed directory the first time they run.
A launcher whose install script did not run links its platform binary beside
itself. A fresh install is in that state on every CI machine. The write changes
a tree after the plan measured it, and every result keyed on that tree would then
be stored under bytes its run did not read. The rule is: a result is never
stored under a key that names bytes its run did not read.

So a run of a rule whose key measures an installed tree (`TsBuild`, `Typecheck`,
`Vitest`, `EsLint`, `Dprint`, `NodeTest`) finds the keyed entries of that tree
read-only:

| Run                                                                                           | The tree                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Confined                                                                                      | Read-only: it is a read grant                                                                          |
| The workspace declares `S.Sandbox.None()`, host can start `bwrap`                             | Read-only: bubblewrap binds the host as it is, then each keyed entry of the tree read-only over itself |
| The workspace declares `S.Sandbox.None()`, host cannot start `bwrap` (macOS, some containers) | Writable. A write lands                                                                                |
| The target declares `sandbox: "none"`                                                         | Writable. The target asked for the host exactly as it is                                               |

The protected run keeps every file, the network, the process table and the
environment of an unconfined run. It is a mount namespace, and four things
differ in it:

- A file another user owns reads as owned by `nobody`, because the run is in a
  user namespace that maps only its own user and group.
- `sudo` and other setuid programs gain no privileges: `no_new_privs` is set.
- A hard link between a held entry and anywhere else fails as a cross-device
  link, because each held entry is its own mount.
- A tool a signal kills is reported by its exit status, 128 plus the signal.

A target that cannot run that way declares `sandbox: "none"`. Its results are
then never reused. A target that waits for it starts after the write and is
keyed on the tree as it finds it; any other target whose run read the tree
before the write stores nothing in that run.

- The entries held are the ones a key measures and a bind can hold: `.bin`,
  `.pnpm`, and each other entry that is not a link and whose name does not start
  with a dot. A tool's own state under a dot name (`node_modules/.vite`,
  `node_modules/.cache`) stays writable.
- A write into a held entry fails with a read-only file system error. A launcher
  built for one runs its binary from where it is and writes nothing.
- A tool that cannot work under the protection fails that run. When its output
  names a read-only file system, a cross-device link, refused privileges, or
  bubblewrap itself, the run is made once more without the protection, the line
  `ran again with its installed trees writable` is printed, and the target keeps
  its verdict. If the tree changed, results keyed on it are not stored in that
  run. A tool that fails another way under the protection is not run again:
  declare `sandbox: "none"` on that target.
- Before any result keyed on an installed tree is stored, the tree is measured
  again. A tree that differs stores nothing and prints the reason below. This
  holds on every host, protected or not.

Only those six rules are held. A `Shell` target that writes into `node_modules`
still changes the tree. To keep such a run's results, run the tool once after
the install and before `smthrs`, or let its install script run.

`build-cli/test/InstalledTreeFirstUse.test.ts` runs a launcher that links its
binary on first use, in a real workspace under real bubblewrap: the tree is
unchanged after the first run and the second run hits. It also covers the tool
that cannot fall back and the host that cannot protect.

### A target is keyed on what it reads when it starts

A plan measures every target's inputs before anything runs. A target that waits
for another can then start over other bytes: the target before it rewrote a
file, added one to a directory, removed one, or pointed a link somewhere else.
A target declares its outputs; what else it wrote is not known. A result stored
under the planned key would answer a later run for bytes its run never read.

So the inputs are measured again, twice:

- **When a target starts**, if a target it waits for ran in this run. Its
  files, globs, links, groups of files, import closures and installed trees are
  measured as they are then, and the lookup and the stored result use that key.
  When the key differs from the plan, the run says what moved:

  ```text
  //packages/app:test  planned again: packages/app/src/version.ts changed since the plan
  ```

- **After a target's run**, before its result is stored. A result whose inputs
  no longer measure as they did when the run started is not stored, and neither
  is the result of a target that waits for it: its key would name that target's
  key. The same holds for a target that waits for one whose installed tree
  changed while it ran.

A target answered from the cache puts back the outputs it declares and nothing
else. A target that waits for it is measured again at its start only when one
of its inputs can name such an output, as a glob over a directory the build
writes into does. In a fresh checkout that target is then keyed on the files
put back, and is answered too.

A file the target declares that it writes, an `outFiles` entry or a file under
an `outDirs` entry, is what it made, not what it read: a build that writes into
a directory it also reads still stores its result.

### A target whose writes nothing proves runs when another waits for it

A result answered from the cache puts back the outputs the target declares. A
confined run can write nothing else: a write it does not declare fails it. A
run nothing confines can write any file, and nothing records which. Answered
from the cache it would write none of them, and a target that waits for it
would read a tree no run of it leaves.

So such a target is not answered from the cache while a target that waits for
it is in the run. It runs, and says why:

```text
//:generate  runs again: nothing confines or observes its run, and //:test waits for it
```

The summary carries the sentence as the target's `notReused`:
`nothing confines or observes its run, and a target that waits for it is in this run`.
Its result is still stored: a run that builds it alone, or with only a `Suite`,
an `Alias` or a group of files waiting for it, is answered. The targets that
wait for it keep their own results; each is planned again when it starts and
is answered when the files it declares are the ones its last run read.

| The target                                                                                    | While another waits for it                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Shell.Build` or `Shell.Test` with `sandbox: "none"`, or in a workspace that confines nothing | Runs                                                     |
| `NodeTest` or `ToolBuild` reused on `cache: true` alone, where nothing confines it            | Runs                                                     |
| A confined target                                                                             | Answered                                                 |
| A test, type check or lint reused [with evidence](#results-reused-with-evidence)              | Answered: its result is stored only after a confined run |
| A `Shell.Test` with `observe` on a host that records reads                                    | Answered from its record, and what it left is put back   |
| A group of files, a fetch, a bundler graph: what the build makes itself                       | Answered                                                 |

On a machine only the targets of that machine count: no other target sees its
copy. A target in the workspace counts for every target after it, because a
machine made later copies what it left.

To have it answered again while others wait for it, let the build prove what
it writes: confine it (drop `sandbox: "none"`, and declare what it writes as
`outFiles` or `outDirs`), or observe it (`observe: true` on a `Shell.Test`).

`build-cli/test/RemeasuredInputs.test.ts`, "a target nothing confines or
observes", runs the build that writes a file it does not declare, the same
build with nothing waiting, two machines, and the build confined.

A target that names a [machine](#a-machine-for-the-steps-of-a-job) reads its
machine's copy of the workspace, so its inputs are measured there: a step that
rewrites a file in the copy re-keys the step after it, and the workspace's own
file does not. The steps of a machine run one at a time in a copy nothing else
writes, so a step there is not measured after its run: a file that changed
while it ran, it changed itself.

A target that cannot be measured again when it starts fails with
`its inputs could not be measured again before it ran` and the error. One that
cannot be measured after its run keeps its verdict and stores nothing.

A target that waits for an installation was already planned again when the
installation finished; the measurement after its run is made the same way.

A target that is [reused from what its run read](#results-reused-from-what-a-run-read)
is answered from its record, held against the tree as it is when the target
starts. No key names its inputs, so it is not planned again; a target that
waits for it measures its own files when it starts.

What this costs follows the targets that run, not the graph:

| Target                                                         | Measured again                   |
| -------------------------------------------------------------- | -------------------------------- |
| Answered from the cache, nothing it waits for ran              | Never                            |
| Answered from the cache after a build put back a file it reads | At its start                     |
| Runs, nothing it waits for ran                                 | Once, after its run              |
| Starts after a target it waits for ran                         | At its start, and after its run  |
| Fails                                                          | At its start at most             |
| Starts beside others after the same targets ran                | They share one walk of each glob |

A file whose size and times are unchanged since the plan is not read again. An
installed tree is walked again only at a target's start, never after its run:
the check that holds a tree for a run already measures it then.

Two targets with no dependency between them have no order. One that reads what
the other writes waits for it, through `deps` or `data`.

`build-cli/test/RemeasuredInputs.test.ts` runs real processes in a real
workspace: a build that rewrites a file a test declares, adds one, deletes one
and retargets a link; a file behind a group of files and behind an import
closure; two steps of one machine; a build answered from the cache whose output
a test reads; a target that changes its own inputs; a build that writes its
outputs into a directory it reads; and how many measurements each run makes.

### Why a result was not stored

A green target that stores nothing runs again next time. Each one has a reason.

A reason the run found is printed on the target's own line:

```text
//packages/app:lint  not cached: an installed tree changed after it was planned: node_modules unit .pnpm/formatter@1.2.0: node_modules/formatter/native was written
```

| Reason                                                           | What the line adds                                             | What to do                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `an installed tree changed after it was planned`                 | The tree, the unit, and up to three paths written in it        | Find what wrote there. Run it before `smthrs`, or run again: the next run plans the new tree |
| `it passed, but failed when confined to its declared inputs`     | The paths the confinement closed, and the file with its output | Declare the missing inputs                                                                   |
| `an installed tree is a link or links out of the workspace`      | The tree                                                       | Install into the workspace                                                                   |
| `its inputs changed while it ran`                                | The first file that changed                                    | Find what wrote it. A target that writes a file it reads declares it as an output            |
| `the inputs of a target it waits for changed while that one ran` |                                                                | Fix that target, whose own line says what changed; this one is stored again when it is       |
| `its inputs could not be measured again after it ran`            | The error                                                      | Fix what the error names                                                                     |
| `its run's search path is not the one it was planned under`      |                                                                | Plan and execute under one `PATH`                                                            |
| `this host cannot confine a run to its declared inputs`          | One line for the run names what the host lacks                 | Install `bubblewrap` on Linux. Hits stored elsewhere still answer                            |
| `the cache could not store it`                                   | The store's error, on a `smthrs:` line                         | Fix the cache directory or the remote                                                        |
| `its result cannot be written as a cache entry`                  | Why, on a `smthrs:` line                                       | Return a plain value from the target                                                         |

A changed unit reads `was added` or `was removed` when the unit itself appeared
or disappeared, and `changed` when no entry in it is newer than the plan's
measurement. `; 2 more units changed` counts the rest. `could not be measured
again` means the tree could not be read after the run; nothing is stored then
either. On a host that could not hold the tree read-only, the line ends with
why.

The last line of the run counts every green result that was not stored, by
reason. It adds two kinds the run does not print one by one: a plan's own
decision (`the target declares cache: false`), and one of the six rules above
planned in a way that reuses no result (`Dprint results are not reused`).

```text
6 targets: 2 hit, 4 ran, 0 failed, 0 skipped (41.0s)
4 results not stored: 2 an installed tree changed after it was planned; 1 Dprint results are not reused; 1 TsBuild results are not reused
```

The structured summary carries the same counts as `notStored`, a list of
`{ reason, count }`, most common first. A target's own row carries `notStored`
only for a reason its run found. `--results-file` writes both.

A stored result that is not reused prints a line too:

```text
//packages/app:test  not reused: its stored result read dependency outputs that have changed: packages/app/dist
```

### What is not reused

- **macOS and Docker.** Seatbelt and Docker have no scratch layer, so no
  evidence is gathered under them.
- **A check that a confined run really ran every case.** A suite that skips
  cases when an undeclared file is missing can be cached green without them.
  Comparing the confined run's case count with one unconfined run's would catch
  it and is not built.
- **Host files.** A confined run still reads the enumerated system paths
  (`/usr`, `/etc`, the runtime). A system library replaced under an unchanged
  runtime binary is not in the key.
- **An embedding host's environment.** A target body resolves its package
  manager from the process `PATH`. A host that plans under another `PATH` gets
  no evidence and no stored result, instead of a result keyed on programs it
  did not start.
- **Windows.** The POSIX fixtures skip there; wrapper identity needs its own
  evidence.

`build-cli/test/CatalogToolIdentity.test.ts` covers source, manifest, config,
lockfile, and dependency invalidation; unchanged and unrelated-file stability;
manager, runtime, and PATH-selected interpreter byte identity; relative lookup
refusal; missing, non-executable, cyclic, and unidentifiable launcher refusal;
and executable replacement between planning and execution.

These rules accept absolute launcher paths or bare names on an absolute `PATH`.
Relative launcher paths and relative or empty `PATH` entries refuse planning:
package-directory probes and workspace-directory services can otherwise select
different executable bytes. The `smthrs` process entry resolves relative `PATH`
entries against the launch directory and drops empty ones before planning, so
`pnpm exec smthrs` works with its `./node_modules/.bin` entry. A host that
embeds the CLI with its own environment passes an absolute launcher or absolute
lookup directories.

## Keys vary by verb

The planner resolves a target's attrs, declared inputs, declared outputs, and
cacheability through `Metadata.forKind(verb)` for `build`, `test`, `lint`,
`run`, and `docs`, and uses the declared form for `graph` and `query`.

A target that maps one verb to a different form of its attrs therefore has a
different content key under each verb. The generator targets do exactly this: under
`lint` they run their drift-check form, which declares the output file as an
input and is cacheable, and under `build` they run their write form, which
declares no output input and is not cacheable.

Dependencies never vary by verb. See
[Verb-effective attrs](../concepts/targets.md#verb-effective-attrs).

## The result cache

The executor opens the cache once per run and closes it afterwards.

Local entries live under `<cacheDirectory>/cache/<first two characters>/<key>.json`.
A key that is not already a safe single path segment is replaced by its sha256, so
a key can never escape the cache directory.

A stored entry holds the key, the target, the label, `exitOk`, the target's success
value, and an ISO timestamp. A success value that cannot be recorded faithfully
is not stored at all; see [Storage](#storage).

### Publication is atomic

The entry is written to a sibling temporary file and renamed onto the entry path,
following Bazel's `DiskCacheClient.saveFile`:

- The temporary file is created with exclusive create under a name unique to the
  write, so two writers of one key can never share it and a stale temporary file
  left by a crashed process is never adopted.
- The bytes are flushed to the device and the file is closed before the rename.
  The operating system is free to reorder a write and a rename, so without the
  flush a crash can leave a renamed but empty entry.
- A failed close never publishes as success, and the containing directory's
  fsync is real I/O: on POSIX only the narrow codes that mean the filesystem
  does not implement directory sync are tolerated, while permission, open, and
  unknown errors fail the write. Windows has no portable directory descriptor
  through Node and skips the barrier deliberately.
- Temporary removal is attempted on every failure. If it fails, the diagnostic
  retains the primary error code and reports cleanup as a secondary cause;
  cleanup failure after an otherwise-complete concurrent publication is also
  reported rather than silently leaking one file per writer.
- On POSIX the rename replaces the destination atomically, and the directory
  entry is flushed afterwards. Windows refuses a rename onto a destination another
  process holds open; because entries are content addressed, an existing
  destination that decodes for the key is accepted as the same publication rather
  than reported as a failure.

A reader therefore sees either no entry or a whole entry, never a partial one.

### A declared cache directory stays inside the workspace

A declared `cacheDirectory` is validated lexically: it must be relative,
non-empty, and free of `..`. A repository's content never chooses a path
outside its checkout. That is not enough on its own, because the directory it
names can be a symbolic link to somewhere else entirely. Every ancestor is
therefore resolved when the cache is opened, again after the directory is
created, and again before an entry is written, and a cache directory that
leaves the workspace fails the command before anything is created out there.
`Exec` applies the same check before it substitutes the cache-directory token
into a tool's argv and env values.

A directory outside the workspace is there on purpose: the command line named
it with `--cache-dir`, or the machine placed it for `S.Cache({ outside: true })`.
It is created where it is named, and the workspace check is skipped for it.
Everything inside it keeps its checks: the result cache and the content store
must not be links that leave it. See
[Configuration](configuration.md#precedence).

The unavoidable limit: Node exposes no portable descriptor-relative open, so an
ancestor directory replaced by an outside-pointing link between a check and a
later write is not detected. What is closed is the durable case: a workspace
whose cache directory is a link.

### Reads are bounded and untrusted

An entry file may have been written by another workspace, hydrated from a
shared remote, restored from a backup, or hand edited, so the read defends
itself:

- `lstat` refuses a symbolic link, FIFO, device, socket, or directory before
  anything is opened. The open adds `O_NOFOLLOW` and `O_NONBLOCK` where the
  platform provides them, and the descriptor is `fstat`-checked to be the same
  regular file. A concurrent publish loses that identity check and is retried.
- An entry larger than 16 MiB is a miss, checked on the descriptor before a
  byte is read.
- A remote body is capped at 1 MiB (the server's action-entry limit), by exact
  `Content-Length` when declared and by accumulated bytes and chunk count while
  a chunked or streaming body is read. Local entries retain the 16 MiB ceiling.

Every request to the remote (the fetch, its whole body, and the parse) runs
inside one deadline that is a real race against a timer, not only an
`AbortSignal`. A `fetch` that ignores the signal, or a body that never
completes, degrades the store to local-only instead of hanging the run.
Metadata reads use 3 seconds and writes use 8 seconds; artifact transfers use
60 seconds, including verification and local blob publication. Bulk missing-blob
probes send at most 128 digests with a batch-scaled deadline: the metadata write
budget plus 25 milliseconds per digest, capped by the artifact read budget.
The default full-batch deadline is 11.2 seconds. An explicit `timeouts.get`
override caps probes, and `timeouts.put` supplies their base budget. Output-limit
refusals skip that entry while leaving other remote operations available.

### Admission

An entry answers for a target only when all of the following hold:

- It decodes, and it names the requested key.
- It names this target's definition and this target's label. Key equality alone is
  not identity: a store shared between workspaces, or a hostile remote, can
  file another action's result under a forged key.
- `exitOk` is true. A stored red result is never replayed.
- Its output manifest matches the target's declared outputs exactly and
  measurement still agrees with it, when the target declares outputs.
- The target's declared inputs still match the snapshot the plan measured,
  checked before the lookup and again after the outputs are measured.

Anything else is a miss, and the target executes.

### Declared outputs are exact

A target declares its output tree, a `cwd` and an ordered list of paths, as
target metadata. `ToolBuild`, `TsBuild`, and `DtsBuild` all do. The declaration is
never read back out of attrs or out of a cache entry, so neither an untrusted
entry nor a producing implementation gets to choose which paths are verified.

Both a fresh success and a cache admission require a top-level manifest whose
entries match the declaration one for one, in declaration order, with a
non-negative safe-integer `fileCount` and a lowercase 64-character hex
`contentDigest`. An omission, an extra, a reorder, a duplicate, a forged path, a
malformed count or digest, and a missing manifest are all refused. Every
declared path is then re-measured.

The two outcomes differ by side: a cache entry that fails this is a miss, and a
fresh success that fails it is a **target failure**. A producing implementation
that returns success without its manifest has proved nothing about its outputs,
so it fails rather than caching green. A target that declares no outputs is not
required to carry a manifest, and an `outputs` member on such a target's result is
never used to decide what gets measured.

The declaration itself is validated where the target is written and again at
execution: an absolute path, a `..`, the declaring directory itself, anything
under `.flows` or `.git`, two paths that resolve to the same output, and a path
already covered by another are all refused. See
[ToolBuild](../reference/targets/tool-build.md) for the full list and the reason
each one exists.

### Measurement is bounded and race-checked

Measuring an output is what makes a manifest evidence, so it defends itself the
way an entry read does:

- File contents stream through one fixed buffer. An artifact of any size costs a
  fixed amount of heap, and a large output no longer forces a whole-file
  allocation.
- Every file is opened with `O_NOFOLLOW` and `O_NONBLOCK` where the platform has
  them, and the descriptor is `fstat`-checked to be a regular file with the
  identity its parent listing observed. A symbolic link, FIFO, or device swapped
  in after the listing is refused, and a FIFO cannot block the open.
- The file is `fstat`-checked again after its last byte. A file appended to,
  truncated, or replaced while it was being read fails the output rather than
  contributing a digest of something that no longer exists.
- Every traversed directory is re-checked against the canonical workspace root
  and against the identity its parent observed, before and after its entries are
  read. A directory renamed mid-capture fails the output rather than publishing
  a manifest assembled from two trees.
- The tree's metadata is capped on file count, nesting depth, per-path bytes,
  and total path bytes, and passing a cap fails the whole output. There is never
  a truncated manifest.

The unavoidable limit is the same one the cache directory has: Node exposes no
portable descriptor-relative open, so the window between the last check and the
syscall it guards stays open for an intermediate directory. `O_NOFOLLOW` and the
descriptor's own `fstat` close it for the file being hashed. This is not race
freedom; it is every check a portable Node API can make.

### Inputs are revalidated, not assumed

The planner measures a target's declared inputs once. Everything after that (the
key a hit is admitted under, the key a result is published under) is only sound
while that measurement still holds, so it is taken again: before the
lookup and execution, after output validation on the hit path, and after a
successful execution. Paths and per-file digests are compared, not only how many
files matched.

A changed or unreadable snapshot is an ordinary target failure: the target
reports `failed`, its dependents report `skipped`, nothing is published, and
every other target still runs. It used to be a warning line followed by a green
`ran`.

The unavoidable limit: a file can always change between the last comparison and
the syscall that acts on it. No portable filesystem API hands out a token for a
version of a tree. What this closes is the whole plan-to-execution window, which
is seconds or minutes wide in a real run.

### Storage

- A lookup runs only when the target is cacheable and `--no-cache` was not passed.
- A hit reports `hit`, skips the run, and does not re-execute the tool.
- A green run of a cacheable target stores its result. A failure to store prints
  one warning line and does not fail the run.
- A result produced outside an enforced confinement is stored in the local tier
  only. Publishing to the remote tier needs a confined run; see
  [Hermeticity](../concepts/actions-and-boundaries.md#hermeticity).
- `--no-cache` bypasses reads and still writes.

Only a result that round trips through JSON without type loss is stored: null,
booleans, finite numbers, strings, plain objects, and dense arrays of the same. A
cycle, a nested `undefined`, `NaN`, `Infinity`, a bigint, a function, a symbol, a
`Date`, a `Map`, and a class instance all leave the target green and skip
publication with a diagnostic. A top-level `undefined` is the one accepted
non-JSON value: it is what a target whose success schema is `Void` returns, and an
explicit tagged envelope records it without confusing it with `null`. Storing
an unserializable result as `null` and replaying it later was the bug this
replaced.

A cacheable target that declares `outputs` (ToolBuild, TsBuild, bundlers,
Fetch, and the other `Target.make` rules) stores every declared output in the
local content-addressed store beside its success value. A hit first measures the
outputs on disk against the recorded digests. When they no longer match, as
after deleting `dist`, the stored trees are verified blob by blob, materialized
byte-identical, and measured again before the hit is reported; the tool does not
run. A stored manifest must name exactly the declared paths, and a missing or
tampered blob, or an output over the tree limits at capture time, is a miss that
re-executes the target.

A configured remote tier publishes output blobs before its result entry.
Missing local blobs are downloaded and SHA-256 verified before the runner
restores outputs. Files larger than 16 MiB use deterministic chunks and a small
index, while the manifest retains the whole-file digest. Missing or corrupt
chunks are misses and leave no partial output file. Old whole-file local entries
remain readable. See [Remote caching](remote-caching.md) for bounds, credentials,
failure behavior, and retention.

## Planning versus caching

The planner computes the key but consults no result cache; it reuses only the
file digests an earlier plan read, while each file's status is unchanged (see
[Remembered digests](../concepts/inputs.md#remembered-digests)). `--plan` output still reports
`cacheLookup: "not-wired"` and `wouldRun: true` for every target. Those two
fields are stale relative to the executor, which performs the real lookup at
execution time.

## Next

- [Remote caching](remote-caching.md)
- [Inputs](../concepts/inputs.md)
- [Actions and boundaries](../concepts/actions-and-boundaries.md)
