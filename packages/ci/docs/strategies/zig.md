---
title: "The Zig strategy"
description: "Which files a Zig build step or entry file reaches, read from what the Zig toolchain reports: the step graph, the build server and the cache manifests of the compiler."
---

Contract 9 for Zig: given build steps or entry files, every file they reach.
Code: `src/closure/zig`. Needs Zig 0.17; any other release is refused.

```ts
import * as Zig from "./src/closure/zig/index.ts"

Zig.close(root, ["test", "src/main.zig"]) // contract 10: one closure per entry
Zig.groups(root, ["test"]) // the named steps each step only groups
Zig.steps({ root }) // the steps there are, and which run a test binary
Zig.ofSteps({ root }, ["test"]) // one closure per build step
Zig.ofFiles({ root }, ["src/main.zig"]) // one closure per entry file
```

`close` is contract 10's `CloseEntries`. An entry that ends in `.zig` is an
entry file; any other entry is the name of a build step, as `zig build` takes
it (`test`) or as Zig names the step itself (`run test test-base`).

For the other three, `root` is the repository, `directory` is where `build.zig` is when that is not
the root, `args` are passed to every `zig build` (`-Doptimize=ReleaseSafe`
changes what a step reads), `zig` is the executable and `cache` is the cache
directory to build in. The functions need Effect's `FileSystem`, `Path`,
`ChildProcessSpawner` and `Digest` services.

## How it works

Nothing parses Zig source. Each fact comes from the toolchain.

```
zig build --print-configuration      the step graph, as ZON
        │
        ▼
steps the entry depends on ──────────┐
        │                            │ paths a step declares in build.zig
        │ compile steps only         │ (a file given to a command)
        ▼                            │
zig build --listen=-                 │
   builds those steps, reports       │
   each one's output path            │
        │                            │
        ▼                            ▼
<cache>/h/<name>   the manifest:   files ── read, SHA-256 ──▶ Closure
   every file the compiler read
```

1. **The step graph.** `zig build --print-configuration` prints every step,
   what it depends on and what it declares. Zig 0.17 runs `build.zig` in its own
   process and saves the result, so this costs milliseconds once cached.
2. **What a step declares.** A file passed to a command with `addFileArg` or
   `addFileInput`, an installed file, a file to format: these are paths in the
   configuration. A path that is a file goes in the closure.
3. **What a compile step reads.** Only the compiler knows which files
   `@import` and `@embedFile` reach, so the compile steps are built. The build
   server protocol (`zig build --listen=-`) takes a list of step indices, which
   lets the strategy build compile steps without running a single test, and
   answers with each step's output path, `o/<digest>/<name>`.
4. **The manifest.** For each cached step Zig writes a manifest listing every
   file the step read, with a digest of each. The output directory's name is a
   hash of the manifest's name and those digests (`Manifest.finalDigest`). The
   strategy recomputes that hash for each manifest and takes the one that equals
   the reported output directory. A manifest is used only on an exact match.
5. **The build files.** The configuration is cached the same way, under
   `c/<digest>`, and its manifest lists `build.zig`, every `build.zig.zon`, each
   dependency's `build.zig` and every file `build.zig` asked to track. These go
   in every closure, because they decide what every step is.
6. **An entry file.** With no `build.zig`, `zig test FILE -fno-emit-bin
   --listen=-` analyzes the file and reports the files it read in one message.

The closure of a step is the union over the step and everything it depends on.
Building is not wasted work: it fills the same cache `zig build test` reads.

### Where each input goes

| The toolchain reports                                            | The closure gets                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A file under the repository                                      | `files`, with the SHA-256 of its content                                  |
| A directory under the repository                                 | `directories`: a file added to it later is read too                       |
| The repository's own root, read whole                            | `dynamic`: every change is under it                                       |
| A file in Zig's own library directory                            | the package `zig@<version>`                                               |
| A fetched package (`p/<name-version-hash>/` in the global cache) | the package of that name. `build.zig.zon` pins its hash and is in `files` |
| Any other file on the machine, such as a system header           | the package `host`                                                        |
| A file in a cache directory                                      | nothing: a step or the toolchain derived it from inputs listed above      |

### What makes a closure incomplete

A consumer treats a closure with `unresolved` or `dynamic` entries as affected
by every change. The strategy writes one when:

- a compile step fails. Each compile error is an entry, against its file;
- a compile step was built but no manifest matches its output, as happens with
  `-fincremental`, which keeps no list of inputs;
- a step reads the whole repository, as `zig fmt .` does. A narrower directory
  (`zig fmt src`, `installDirectory`, `addDirectoryArg`) goes in `directories`
  and leaves the closure complete;
- a command is one Zig itself reruns every time: marked as having side
  effects, wired to the terminal, or writing nothing the build can see. This is
  the rule in Zig's `Run` step, copied;
- `build.zig` reads something Zig cannot track, so the configuration is never
  cached;
- a step declares a path in another package, a path outside the build, or is of
  a kind Zig 0.17 does not have;
- a file in the closure cannot be read.

The strategy fails, and a consumer should treat every step as affected, when
Zig does not start, is not 0.17, `build.zig` does not configure, a step name is
unknown or the build server stops early. `close` fails with contract 10's
`Failure`: `unsupported` for another Zig release, `command-failed` for the
rest. The other functions fail with `ZigClosureError`, which says which.

## A CI step that runs `zig build`

The splitter (`src/decompose/Zig.ts`) reads the step graph and leaves the
closures to the run itself.

```
just ci:  tidy, then  zig build test
                          │
          Zig.groups      │  test = test-core + test-cli + test-util ?
                          ▼
   yes: one step per named step        no: the step as it was
   zig build test-core  ┐
   zig build test-cli   ├ at once      zig build test
   zig build test-util  ┘
                          │
                          ▼
   each runs in the open, with what it reads recorded:
   it runs again only when one of those files changes
```

1. **One step per named step.** `b.step("test", …)` that only depends on other
   named steps does no work of its own: `zig build test` runs what
   `zig build test-core` and the others run. When a CI step is nothing but
   `zig build test`, it becomes one step per named step. A change to a file
   only `test-cli` compiles runs `test-cli` again and no other. A group inside
   a group is opened too. A step that depends on a step with no name, as
   `test` does in a build that adds its test binaries straight to it, keeps
   its command.

   One `zig build test` runs its named steps at the same time, so the steps
   made from it run at the same time too: as many as the machine has cores.
   Other steps that can write the working tree run one at a time.
2. **Nothing but the build.** The split replaces the command, so the command
   must be only `zig build <step>`: alone, after `set` lines, or as the whole
   script of a `bash -c`. `zig build test || true` passes where a build fails,
   so it keeps its command. A flag that only changes how the run is reported
   or how much runs at once goes to every step made from it:
   `zig build test --summary all` becomes `zig build test-core --summary all`
   and the others. Those are `--summary`, `--color`, `--error-style`,
   `--multiline-errors`, `--verbose`, `--test-timeout`, `--seed`, `-j<N>` and
   `-freference-trace`. Any other flag keeps the step whole:
   `-Doptimize=ReleaseSafe` changes what is built, `--maxrss` skips steps by
   what runs beside them, and what follows `--` goes to a program.
3. **No list of inputs.** A step held to a list of files gets a tree it cannot
   write, and Zig's tests write where they start: `std.testing.tmpDir` makes
   `.zig-cache/tmp` beside `build.zig` and stops the test when it cannot. So a
   Zig step names no inputs. It runs in the open and what it reads is recorded
   (see [How it works](../concepts/how-it-works.md#2-targets)): the files the
   compiler read, the files its tests opened, and Zig itself. It runs again
   when one of them changes, which is what a closure promises, taken from the
   run and not from a list written beforehand. A new file an old one starts to
   import needs no list to be brought up to date.
4. **The toolchain counts.** The Zig executable and the library files a build
   reads are among the recorded files, so another Zig release runs every Zig
   step again. The build mode (`-Doptimize=…`) is part of the command.
5. **Zig's caches stay Zig's.** No step is told where Zig keeps its two
   caches. They are where Zig puts them, `.zig-cache` beside `build.zig` and
   one in the home directory, in the step's own job: empty when the job
   starts and gone when it ends, as on a runner. Nothing keeps them for a
   later run, because Zig would answer from them: it runs a test binary again
   only when the binary changed, and does not see what a test reads when it
   runs. `test/decompose/zig.smthrs.test.vibe` changes a file a test reads at
   run time: the step runs again and the test fails.
6. **Any Zig command, not only a bare build.** `zig build test --summary all`,
   `zig build -Doptimize=ReleaseSafe test`, `zig test src/main.zig` and
   `make deps && zig build test` stay one step with their command as written.
   What a step's own run wrote in Zig's caches is not among the files it
   read, so a fresh checkout without them does not make it run again. The
   same test runs `zig build test --summary all` in a directory under the
   root (`working-directory: tools/gen`) on a new machine twice: the second
   is a hit.
7. **Named steps share the caches.** The named steps of one `zig build` run
   at the same time and write both caches at the same time. What each reads
   and writes there is left out of its record (`Zig.caches`): a step beside
   it changes those files while it runs. A step that takes a library another
   step compiled still records the library's source: the compiler it starts
   opens every source file of a cached result before it uses the result. The
   same test changes a library two test roots link, which only one of them
   compiled: both run again.

A Zig step that a later step follows keeps its command and its place: the
later step may read what it built.

### One test binary or several

A build that gives every test to one `b.addTest` has one step for them. Zig
runs a test binary whole, so a change to any file that binary compiles runs
every test in it again. A root file per directory gives each directory a
binary and a step name of its own:

```zig
// src/test_common.zig
test {
    @import("std").testing.refAllDecls(@import("common/root.zig"));
}
```

```zig
// build.zig
const test_step = b.step("test", "Run every test");
for ([_][]const u8{ "common", "execution", "infra" }) |group| {
    const tests = b.addTest(.{
        .name = b.fmt("test-{s}", .{group}),
        .root_module = b.createModule(.{
            .root_source_file = b.path(b.fmt("src/test_{s}.zig", .{group})),
            .target = target,
            .optimize = optimize,
        }),
        // A file two directories import is compiled into both binaries; its tests run in its own.
        .filters = &.{b.fmt("{s}.", .{group})},
    });
    const step = b.step(b.fmt("test-{s}", .{group}), "Run one directory's tests");
    step.dependOn(&b.addRunArtifact(tests).step);
    test_step.dependOn(step);
}
```

The root files sit in `src/`, so a file can still import across directories.
`test` now only groups named steps: `zig build test` runs what it ran, each
binary compiles only what its directory reaches, and Smithers CI makes one
step per name.

## Measured on needlefish

`refcell/needlefish` at `bfb4869`: Zig 0.17.1, one `build.zig`, no
dependencies, 1,152 files under `src` and `bin`. Run on a shared 48-core
machine.

| Test step                                   | Files in the closure | Complete |
| ------------------------------------------- | -------------------: | -------- |
| `test`                                      |                1,147 | yes      |
| `run test` (the `base` module's unit tests) |                1,072 | yes      |
| `run test test-base`                        |                1,039 | yes      |
| `run test test-witness-diff`                |                  956 | yes      |
| `run test test-replay-roots`                |                  956 | yes      |

`test/closure/zig/Repository.test.vibe` edits one file at a time in a copy of
the repository, asks Zig to build all fourteen compile steps again, and compares the
steps Zig rebuilt with the steps whose closure holds the file.

| Edited file                             | `test` | `run test` | `run test test-base` | `run test test-witness-diff` | `run test test-replay-roots` | Compile steps Zig rebuilt | Compile steps whose closure holds the file |
| --------------------------------------- | :----: | :--------: | :------------------: | :--------------------------: | :--------------------------: | ------------------------: | -----------------------------------------: |
| `README.md`                             |   no   |     no     |          no          |              no              |              no              |                         0 |                                          0 |
| `bin/witness-diff/main.zig`             |  yes   |     no     |          no          |             yes              |              no              |                         2 |                                          2 |
| `bin/base/main.zig`                     |  yes   |     no     |         yes          |              no              |              no              |                         2 |                                          2 |
| `src/testing/simulator_main.zig`        |   no   |     no     |          no          |              no              |              no              |                         1 |                                          1 |
| `src/execution/evm/state_test_main.zig` |  yes   |     no     |          no          |              no              |              no              |                         1 |                                          1 |
| `src/common/rlp/testdata/rlptest.json`  |  yes   |    yes     |          no          |              no              |              no              |                         1 |                                          1 |
| `src/common/rlp/root.zig`               |  yes   |    yes     |         yes          |             yes              |             yes              |                        14 |                                         14 |
| `src/base.zig`                          |  yes   |    yes     |         yes          |             yes              |             yes              |                        14 |                                         14 |
| `build.zig`                             |  yes   |    yes     |         yes          |             yes              |             yes              |                         0 |                                         14 |

`rlptest.json` is read with `@embedFile` inside a test, so only the unit test
binary holds it. `state_test_main.zig` is the root of a program that `test`
compiles and no test step runs. `simulator_main.zig` is outside `test`.

For every source file the closures name exactly the steps Zig rebuilt. They
name more only for `build.zig`: the edit added a blank line, the build graph
came out the same, and Zig rebuilt nothing. Every closure holds `build.zig`
because another edit to it can change any step.

### Four commits replayed

`smithers-ci --commits 4 --no-trial` on needlefish's four commits up to
`06d8113`, on a shared machine with a fixed share of its processors. Its CI is
`just ci`: `tidy`, then `zig build test`, which runs 3,180 unit tests in one
test binary and three small ones. Each way first runs once at the commit
before, which is not counted: 31.7 minutes as CI, 28.6 as targets. No step's
result differed from CI's.

| Commit    | Changed           |     As CI | As targets | What ran again    |
| --------- | ----------------- | --------: | ---------: | ----------------- |
| `55590ed` | `bin/base`        |  28.8 min |   29.3 min | `test`            |
| `a66baf9` | one file in `src` |  34.5 min |   33.3 min | `test`            |
| `2aee274` | one docs file     |  35.1 min |        4 s | nothing           |
| `06d8113` | 38 files          |  30.1 min |   32.5 min | `test`            |
| Total     |                   | 128.4 min |   95.1 min | 1.35 times faster |

`tidy` takes a second and runs at every commit: it reads which commit is
checked out. A `test` that runs compiles and runs every binary from empty Zig
caches, as `just ci` does on a new machine. So a commit that changes a file
the step read costs what the CI costs, between 0.97 and 1.08 times its time
here with the recording, and the gain is the commits that change no file a
step read. One binary holds all 3,180 tests, so any change under `src` runs
them all: that is what bounds the number. With
[a test binary per directory](#one-test-binary-or-several) each directory has
a step of its own, and a change runs only the steps whose own run read it.

The machine was shared: the same full run took between 29 and 35 minutes. One
test in `bin/base/log_relay.zig` was made to skip when the kernel refuses a
larger pipe, which that machine does under load; nothing else in the
repository was changed.

## What it cannot see

- **What a test reads when it runs.** A test that opens a file at run time,
  reads an environment variable or calls a program has an input no build tool
  sees. Zig's own cache has the same blind spot. `@embedFile` is seen.
- **A file named by a plain string.** `b.addSystemCommand(&.{ "sh", "tool.sh" })`
  hides `tool.sh`; `addFileArg(b.path("tool.sh"))` declares it. The strategy
  trusts what `build.zig` declares, as Zig's cache does.
- **Programs outside the repository.** A command that runs `cp` or `python3`
  depends on that program. Nothing records it.
- **Other targets and options.** A closure holds for the `args` it was built
  with. `-Dtarget=aarch64-macos` or `-Doptimize=ReleaseFast` can reach other
  files, since Zig analyzes only the branches a target takes.
- **Files Zig would read after a change.** A closure describes the tree it was
  built from. A new file matters only once a file in the closure imports it,
  and that edit is itself a change to the closure.
- **Fetched packages, file by file.** A fetched package is one name. Its
  content is pinned by the hash in `build.zig.zon`.
- **Part of a test binary.** Zig runs a test binary whole. `--test-filter` is
  given when the binary is compiled and takes one substring, and the filtered
  compile still reads every file the unfiltered one reads, so a filter gives
  neither a smaller closure nor a cheaper build. A build that puts all its
  tests in one binary has one step for them: see
  [One test binary or several](#one-test-binary-or-several).

## Costs and limits

- Compile steps are compiled, with code generation. On needlefish, four of the
  fourteen (`zig build check`) took 48 seconds cold on a shared machine, and
  all of them under a second once cached.
- Every manifest in `<cache>/h` is read and hashed to find the matching ones.
- `build.zig` is run, as any `zig build` runs it.
- Zig 0.17.1's build server panics if its input closes while it is building.
  The strategy leaves the input open until the server exits by itself.
- Two things are copied from Zig's source and would change silently with it:
  the SipHash key of the cache and the manifest record layout. Both are checked
  by the exact-match rule above: if either changes, no manifest matches and
  every compile step is reported as unresolved.
- The configuration text does not print a module's root file or its imports,
  so the strategy cannot answer "which step compiles this file" without
  building. It also prints the owner of a path in another package as a bare
  number.

## What was considered and left out

| Source                                     | Why not                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Following `@import("…")` strings in source | It is what ZLS does to find a file's imports (`collectImports` in `src/DocumentStore.zig`, `.zig` files only, "Does not include imported modules"). It misses `@embedFile`, modules named in `build.zig`, generated files and anything behind `comptime` branches, and it guesses where the compiler knows |
| `zig build --watch`                        | It keeps the same list of inputs per step, but only in the memory of the running build                                                                                                                                                                                                                     |
| The compiler's dependency file             | `--dependency-file` exists only as a linker argument of `zig cc`; `zig build` cannot ask for it                                                                                                                                                                                                            |
| `zig build --verbose`                      | It prints each compile command, which names modules and root files, but only while building, and it lists no imported file                                                                                                                                                                                 |
| Reading the binary configuration file      | It holds module roots and import tables, which the ZON text lacks, but its layout is private to one Zig release                                                                                                                                                                                            |
| Bazel's `rules_zig`                        | It asks for every source file by hand in `srcs`, and `@embedFile` files in `extra_srcs`                                                                                                                                                                                                                    |

## Sources

Read in the Zig 0.17.1 source tree (`https://codeberg.org/ziglang/zig`, tag
`0.17.1`) and run against the 0.17.1 release.

| What                                                     | Where                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The step graph and its ZON printer                       | `lib/std/Build/Configuration.zig`, `lib/compiler/Maker/ScannedConfig.zig` (`print`)                                                       |
| `--print-configuration`, `--listen=-`, the protocol loop | `lib/compiler/Maker.zig`                                                                                                                  |
| Build server and compiler messages                       | `lib/std/zig/Server.zig` (`bsp_step_completed`, `BuildStepCompleted`, `file_system_inputs`), `lib/std/zig/Client.zig` (`bsp_build_steps`) |
| The manifest layout, the hash and its key                | `lib/std/Build/Cache.zig` (`Manifest.File`, `finalDigest`, `hasher_init`)                                                                 |
| The five path prefixes                                   | `src/Compilation.zig` (`cache.addPrefix`, in `create`)                                                                                    |
| The compiler reporting the files it read                 | `src/main.zig` (`serveUpdateResults`), `src/Compilation.zig` (`appendFileSystemInput`)                                                    |
| The rule for a command that is rerun every time          | `lib/compiler/Maker/Step/Run.zig` (`has_side_effects`)                                                                                    |
| Files `build.zig` asks to track                          | `lib/std/Build.zig` (`dependOnFileContents`)                                                                                              |
| The linker-only dependency file                          | `src/main.zig` (`--dependency-file`), `src/Compilation.zig` (`writeDepFile`)                                                              |

Release notes: [0.17.0](https://ziglang.org/download/0.17.0/release-notes.html),
sections "Separate the Maker Process from the Configurer Process", "Build
Server Protocol" and "Cache System Reworked";
[0.14.0](https://ziglang.org/download/0.14.0/release-notes.html#File-System-Watching),
"File System Watching".

Third parties: [ZLS](https://github.com/zigtools/zls/blob/master/src/DocumentStore.zig);
[rules_zig](https://github.com/hermeticbuild/rules_zig/blob/main/docs/rules.md).
