# Changelog

## Unreleased

- The workspace declaration may be the plain workspace file,
  `.smithers/WORKSPACE.smithers`: a JavaScript module that exports `Workspace`
  and may export `Package`, the root package `//`. Discovery looks for
  `.smithers/WORKSPACE.ts`, then the plain file, then the root `WORKSPACE.ts`,
  and refuses a root that holds both files under `.smithers/`
  (`workspace_root_invalid`). A root `PACKAGE.ts` beside a plain file that
  exports `Package` fails `duplicate_package_path`, and the message now names
  both files. `PackageDiscovery` exports `plainWorkspaceFile`, `workspaceFiles`
  and `isWorkspaceFileName`; `WorkspaceLoader` exports `rootPackageOf`. See
  [The whole declaration in `.smithers/`](../docs/workspace/structure.md#the-whole-declaration-in-smithers).
- `Shell.Test` with `observe: true` is reused from what its run read. The run
  is traced (`strace` on Linux), and the stored result holds every path it
  looked at: each file, each directory listing and each path it did not find,
  inside the workspace and outside it. The next run is a cache hit when each
  of them is unchanged, so a change to a file the command never reads no
  longer runs it again. A target that runs again says what differs:
  `runs again: packages/a/value.js changed`. A run that reached the network or
  a program outside it, or whose trace cannot be read in full, stores nothing
  and says why. A traced run ends when its command ends, and a process the
  command left running is stopped. A host that cannot trace keys the target
  by its `data`, as before.

- A confined `Shell` target finds every tool the host's `PATH` gives. It used
  to see only the program its command named first, so `bash -e -c 'npm test'`
  failed with `npm: command not found` wherever Node is installed under the
  home directory (nvm, fnm, Volta, asdf, mise, `~/.local/node/bin`). The target
  now reads each `PATH` directory, the install root of each program linked out
  of it, a version manager's home and the links between them, and nothing else
  of the home directory. Its key holds each program the text names by its
  bytes, through `bash -c`, `env` and `exec`, where it held the first word's
  alone, and each file that chooses a shim's version by its bytes, so another
  Node or another default reruns it. A `Shell` target whose text names more
  than one program gets a new key once. A command whose tool is not installed
  fails with one line, `<tool>: not found. No directory on PATH holds <tool>;
  install it or add its directory to PATH (exit 127)`.

- A fresh install no longer loses every test, type-check and lint result of
  its first run. A run of `TsBuild`, `Typecheck`, `Vitest`, `EsLint`, `Dprint`
  or `NodeTest` that the workspace does not confine now finds the keyed entries
  of its installed trees read-only (Linux with `bwrap`), so a tool that links
  its binary into its own package on first use writes nothing and the tree stays
  the one the plan measured. A tool that cannot work without the write runs once
  more with the tree writable. The check before a store now covers every
  cacheable target keyed on a tree, and its line names what changed:
  `not cached: an installed tree changed after it was planned: node_modules unit .pnpm/<id>: <path> was written`.
  The summary counts green results that were not stored, by reason, as
  `notStored`; a row and a `--results-file` row carry `notStored` for a reason
  the run found. A remembered confined failure, a run under another `PATH` and
  a stored result whose dependency outputs changed now print their reason too.

- `affected` selects the whole graph when a declaration helper changes: any
  workspace module a `PACKAGE.ts` evaluates, imported by relative path or by
  package name, directly or through another such module. Such a helper builds
  targets in other packages, so its edit was wrongly confined to the package
  that holds it, and the cacheable targets it re-keyed elsewhere never ran
  (#5087).

- Generated `CODEOWNERS` and `OWNERS` include workspace defaults even without
  a root `PACKAGE.ts`. A child repository without its own `.git` runs
  uncached instead of borrowing an enclosing checkout's clean status.
  Editing a file imported by a Nix environment now refreshes its toolchain
  and cache identity instead of reusing the old environment (#5097).

- A declared `outDir` holding a symlink that climbs with `..` but stays inside
  the tree (`bin/tool -> ../lib/tool.js`) now restores from the cache. Its
  manifest was captured, but the decoder refused every `..` target, so the
  target rebuilt and republished on every run with nothing naming the cause
  (#5095). A link whose target is absolute or climbs above the outDir now fails
  the capture and names the link, instead of publishing an entry that can
  never be restored.

- **Breaking:** `affected --list` JSON (and `Affected.select(..., { explain: true })`)
  is factored so it grows with the selection, not with roots times changed
  files. On a 3,948-root repository the old per-(root, file) records reached
  432 MB for 120 changed files and crashed past V8's string limit from 160
  on. Targets lose `reasons` and `reasonDetails` and carry `sources`, indexes
  into a top-level `sources` list of directly affected targets. Each source's
  `changes` indexes `changeSets`, each distinct set of indexes into
  `changes`, each distinct (file, cause) record, so a cause shared by many
  targets, such as a package's `package` cause, is stored once. A top-level
  `edges` map gives each reachable target's direct dependents. A target's
  reasons are the files of `changes[changeSets[s]]` over its sources' sets,
  and its routes are paths through `edges`. Conservative selections name each
  global or unowned file once in `globalCauses`. Selection is unchanged, and
  `affected` without `--list` keeps per-target `reasons`.

- A remote cache with no available credential (unset, empty or whitespace-only)
  now stays local from the start, sends no requests, and prints one
  `smthrs: remote cache off: no credentials` notice per run, instead of a 401
  and two warnings. A cache server that accepts unauthenticated requests now
  needs a non-blank token.

- `affected` no longer selects audited confined native process targets or their
  Filegroup dependencies for unrelated package siblings. Unconfined and
  incomplete contracts remain conservative, including readable output mounts,
  custom workspace lockfiles and symbolic-link inputs. Confined tools no longer receive
  blanket read access to undeclared files in their declaring package.

- An interrupted bundler resolve or build still reports a scratch tree it
  could not remove (#3839). Effect 4.0.4 removes a typed failure from an
  interrupted fiber's cause once the unwind passes a recovery handler, so the
  removal's `ExecError` was dropped and the caller saw a plain interruption.
  The failure now leaves the stop as a defect, so the exit carries both.

- Check-mode targets leave declared `hostDirectories` out of the gitignored
  census and link them into the scratch copy instead of copying them. A large
  or read-only host cache, such as Go's module cache, no longer refuses a
  check over its entry count or fails it when the scratch is removed.

- `review --credential-receiver <absolute executable>` writes each review's
  credential discoveries (revision, file, line and name, never a value) to the
  receiver's stdin before inference. A nonzero exit fails the review; the
  receiver's output is discarded (plue#730).

- `ci` accepts mixed exact labels for different target kinds and runs their
  union once, retaining compatible roots when another label belongs to a
  different verb. An exact label that no CI verb supports still fails (#2482).

- **Breaking:** `KnownRed.Entry` requires `failureDigest`; `Verdict` includes
  `observed` failures. Use `fingerprint` on the complete diagnostic so a new
  failure cannot reuse an old target exemption (#2466).

- Compare all generated declaration files in `Api.Compat`, including ignored output
  directories and directories containing package markers.

- Include nested Filegroup sources, declared output files, and complete output
  directories in `Files.digest` comparisons, including ignored generated files.

- Resolve private local baseline and surface producers in `Api.Compat` by their planned identities.

## 1.0.0-rc.0

- First public release candidate of the Smithers build CLI.
