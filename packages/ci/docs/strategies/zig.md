---
title: "The Zig strategy"
description: "Which files a Zig build step or entry file reaches, read from what the Zig toolchain reports: the step graph, the build server and the cache manifests of the compiler."
---

Contract 9 for Zig: given build steps or entry files, every file they reach.
Code: `src/closure/zig`. Needs Zig 0.17; any other release is refused.

```ts
import * as Zig from "./src/closure/zig/index.ts"

Zig.close(root, ["test", "src/main.zig"]) // contract 10: one closure per entry
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
