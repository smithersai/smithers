# @smthrs/std

## [Unreleased]

### Added

- `Read.Batched` is a wire contract for a filesystem whose every call is a
  network round trip. Over one, `read` and `ls` take one call, and `edit`,
  `write`, and `apply_patch` take two (a snapshot, then a commit that refuses
  the whole batch with `no_match` when any file changed since the snapshot),
  where the cooperative lock protocol took up to ten. Ordinary and versioned
  hosts make the same calls as before.
- `RemoteSearch` answers `grep` and `glob` for a tree on another machine in two
  round trips: the machine's `find` lists the root and `tar` returns its
  `.gitignore` files, then `tar` returns the files the search reads, and
  `PortableSearch` answers over that copy. Results, notices, and refusals are
  the portable peer's. A sealed benchmark host searches its task container this
  way rather than with one container exec per directory and per file.
- `PortableSearch.searched` names the files a `grep` reads for an input.

### Fixed

- Directory exclusions such as `!vendor` and `!dist/` now exclude their
  descendants in native and in-process searches. Remote searches retain every
  hard-linked filename instead of silently skipping later names for the same file.

- `grep` skips and counts NUL-bearing UTF-16 files on every host and rejects
  them when named as the root. Bare CR boundaries now match the same way in
  native and in-process searches, including `^` and `$` anchors.

- A `bash` call past its time limit fails with `timeout` and carries what the
  command printed before it was stopped as `output` (`StdError.PartialOutput`):
  both streams cut on the same terms as a finished command's, their
  `Truncated` flags and `DroppedBytes` counts, and `mutated` for a
  containerised command measured on both sides. It used to carry nothing, so
  a test loop that printed a line per case and hung returned no lines at all.
  `Exec.exec` reports what a timed-out command printed as `ExecError.captured`.
- A `shell_command` or `test` call past its time limit carries what the
  command printed before it was stopped: `shell_command` after its
  `command timed out after` line, as Codex prints it, and `test` as the
  failure's `output`, the end of each stream. Both used to answer with no
  output at all.
- A containerised `bash` call's deadline is enforced inside the container, in
  the same transport call, by `TreeFingerprint.around`. The command, and its
  process group where the container has GNU `timeout` or `setsid`, gets
  `TERM`, then `KILL` after `TreeFingerprint.graceSeconds`; the script still
  measures the tree and reports that the deadline fired. Killing the host's
  `docker` process used to leave the command running beside later ones and,
  over a transport that answers only when the call ends, lose every byte. The
  host's clock is now a backstop at the deadline plus
  `TreeFingerprint.overrunSeconds` and one round trip.
- `TreeFingerprint.split` reads only a line framed with the call's nonce
  (`TreeFingerprint.nonce`), so a command that prints the line's shape and
  kills the script before the real line is written no longer fakes a
  measurement or hides its own output. `split` now takes the nonce and
  answers `timedOut`, and `around` takes the nonce and the deadline in
  seconds as its first two arguments.

- A batched commit receives each file's cooperative lock directory as `Read.BatchedChange.lock`, and a provider that
  finds it held stops with `"locked"`, which the flows report with the ordinary path's `no_match` refusal naming the
  lock. Batched and ordinary handlers now exclude each other, and of two batched edits racing on one file exactly one
  lands.
- `Read.Snapshot.canonical` for a path whose parent is absent is its nearest existing ancestor's resolution joined with
  the rest of the path, where creating its parents puts it.
- `Checkpoints.layerGit` no longer lets an agent redirect a host write through
  the workspace's `.git/config`. It refuses with `permission_denied` when that
  file is a symbolic link, a hard link, or not the regular file named there,
  edits a host copy instead of the file itself, and links the edit back in
  place, so host git never writes through a link (#4902).

- `apply_patch` changes only the lines its chunks change. A written line takes
  the ending of the lines it replaces, so a CRLF file no longer comes back with
  LF lines; context lines keep the file's own bytes; and a file keeps its
  trailing blank line and its final newline, or its lack of one. A
  `*** Move to:` update keeps the moved file's permission bits, and its owner
  where the process may assign it. `edit` and `apply_patch` keep a leading
  UTF-8 byte order mark.

- A command whose arguments exceed the operating system's limit fails with
  `arguments_too_long` under Effect's raw Node spawner too, where Node's
  synchronous `E2BIG` throw used to end the whole run.

- Container commands reject sparse argument arrays and build plans from the
  validated argument snapshot.

- `webfetch` uses one timeout budget across requests, redirects, and response
  body reads. It rejects non-finite and non-positive timeouts before dispatch,
  retains the 30-second default, and caps valid timeouts at 120 seconds.
- `webfetch` owns its redirect loop when composed with the kernel HTTP client,
  reports the final URL, and allows at most ten redirects (eleven requests).
  Each hop remains subject to the kernel's permission check.

### Changed

- `webfetch` caps its rendered `content` at the shared 60,000-byte head budget
  and reports the cut through `truncated` and `notice`, matching `fetch` and
  `http-post`. It previously returned up to 5 MiB of text to the model. The
  5 MiB network read limit is unchanged.
- `bash` measures the tree a containerised command runs in. For an
  `unhermetic` call that names a `container`, the flow runs
  `TreeFingerprint.script` through the container transport in the command's
  working directory before and after the command and reports whether the two
  answers differ as `mutated` on its output: `true` for a tree that changed,
  `false` for one that held still, absent when it could not be measured (no
  transport, no `find` or `stat -c`, a timeout, or a listing past `maxPaths`).
  The host's workspace walk never sees a container's filesystem, so every
  edit an agent made through `docker exec` read as an idle frame: on
  Terminal-Bench 4.0 (2026-09-22) the harness's own read-only cap ended one
  run after twenty-four frames of container writes and its claim judge
  refused another's finished work as never recorded. Two extra `docker exec`
  calls per containerised command, each bounded by the command's own timeout
  and by 60 s.

### Added

- `Checkpoints.makeContainer` and `layerContainer` pin and check out trees
  inside the container `bash` runs in, through the `Container` transport, for a
  host whose repository lives only in that container (#3952).

- Added `TreeFingerprint`: the in-container tree measurement `bash` uses, and
  the owner of the prune and suffix lists `@smthrs/agent/WorkspaceObservation`
  now re-exports, so the host walk and the container measurement skip the
  same derived artifacts. `key` (`"mutated"`) is the reserved output key,
  documented beside `Probe.key`.

- A batched `classify` call reports how long it took. `Classify.askAll` times
  itself and the batch output carries `latencyMs` beside `results`, the way a
  single verdict already carried the transport's. Without it the only timing a
  caller had was the gap between the call's start and settle events, which the
  harness publishes in one tick, so every batched classify card in the
  OpenCode server read about 1 ms while single-state calls read 319, 264 and
  265 ms. The field is additive: `results` is unchanged.

- `Classify` maps evaluator failures with `Classifier.fromEvaluatorError` from
  `@smthrs/model` instead of a private copy.

### Added

- Added the `classify` flow (`Classify`): typed Jev questions about any JSON state, one state or a batch of up to 64 at 32 KiB each, evaluated eight at a time through the `Evaluator` service of `@smthrs/model`. Answers carry probabilities and a confidence per question; a batch keeps every failure beside its state. `Classify.curated(classifier)` declares a `classify/<id>` flow from any `Classifier.make` declaration, with the classifier's state as input and its digest on the declaration.
- Added `Classifiers`: the three curated classifiers `triage/relevance`, `check/verdict`, and `edit/risk`, and `Classifiers.all` for a host to bind as a set.
- `Manifest` registers `classify`; it is part of `Manifest.readOnly` because a `model:call` observes and changes nothing.
- Every flow module now exports `Input` and `Output` as the decoded TypeScript types beside the schemas. Only `Bash` did, so every other caller wrote `typeof Read.Input.Type`.

### Changed

- **Breaking.** Every service key, error tag, and class identifier now carries the package name: `@smthrs/std/<Name>`. `StdError` was tagged `flows/std/StdError`, `Checkpoints.Snapshot` was identified as `flows/std/Checkpoints/Snapshot`, and the `Search`, `Container`, `Checkpoints`, `TestRunner`, `WebSearch`, and `LanguageServer` keys were `/std/<Name>`. An `Effect.catchTag` on the old tag no longer matches; catch `"@smthrs/std/StdError"`.
- **Breaking.** `Checkpoints.unavailable` is now `(id: string) => StdError` and names the checkpoint it was asked for, the same shape as `Container.unavailable`. It was a shared `StdError` value.
- The `LanguageServer`, `Lsp`, `NodeLanguageServer`, `WebFetch`, `WebSearch`, and `ExaWebSearch` module headers describe the module instead of citing a plan file that does not exist, the barrel header names `@smthrs/std`, and every `@since` stamp reads `1.0.0` instead of the never-released `0.1.0`.

- `grep` and `glob` now declare `noIgnore` as the literal `true` rather than a boolean. Ignore files are never consulted in v1, so `noIgnore: false` was accepted by the schema and then refused at runtime; the schema now states what it accepts. A caller reaching `run` without decoding still gets the same `invalid_input` refusal.

### Removed

- Removed `grep`'s `types` input. File-type registries are not supported in v1, so every non-empty value failed with `invalid_input` while the field cost its description in every model frame.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `Manifest.effectsFor`, a frozen name-to-narrowing registry, and the missing `effectsFor` narrowing on `apply_patch`, `shell_command` and `update_plan`, so a host holding a flow name and a decoded input can narrow the envelope instead of serializing against the registry-time worst case.
- Added `SearchContract` as a public module: `validatePattern`, `validateGlob`, `canonicalGlob`, `matchesGlob`, `includedByGlobs`, `expression` and `unsatisfiableNotice` are what an external `Search` peer must build on, and they were reachable only through the null-mapped `internal/` subpath.
- Added default wall-clock timeouts to `bash` and `test` (`DEFAULT_TIMEOUT_MS`, ten minutes) and a capture bound to every buffered command, so a hung command no longer hangs the flow forever and a command printing gigabytes costs the bound rather than the whole of what it printed. `<stream>DroppedBytes` now counts what the process produced rather than what survived the display budget.
- Added package-owned documentation: `docs/api.md` states the limits, the failure codes and the services a host binds, `docs/reference/flows.md` describes every flow's input, output and failures, and `test/Readme.test.ts` fails when `README.md`'s Public API or Limits table, or `docs/api.md`'s module list, no longer matches the barrel. The README's table had named 21 of the 30 exported namespaces, omitting three registry flows a model can call, and stated no limits, no failure codes and no service-binding behaviour.
- Added a `test` flow bound to the repository's declared runner (`TestRunner`): it answers `{passed, failed[ids], parsed, tail}` read from the runner's own report — pytest, unittest and TAP are recognised — instead of twenty kilobytes of stdout, and `against: "base"` runs the same selection again on the pristine base commit in a detached worktree so `introduced`, `preexisting` and `fixed` come back from one call. The base is the engine's `refs/flows/capture-base`, then HEAD.
- Added a `Container` transport service, and `script`/`interpreter`/`args`/`stdin`/`container` inputs to `bash`. A script reaches its interpreter on standard input as data, so no caller composes `docker exec c bash -lc '…heredoc…'` again; the argv for a container is built by the injected transport, and a host with none refuses the call by saying so.
- Added the enclosing definition to every returned `grep` hit where the file's shape says so plainly, so a read window is computed rather than guessed; `symbols: false` turns it off.
- Added `startLine`/`endLine`/`expect` anchoring to `edit`, so an edit can target the span a prior `read` or `grep` hit reported instead of retyping it.
- Added `webfetch`, `websearch`, and `lsp` flows with provider-neutral service boundaries.
- Added one ripgrep-compatible search contract with native `rg` and in-process peer implementations, shared conformance coverage, context lines, case modes, globs, per-file match limits, hidden-file control, and files-with-matches output.

### Changed

- **Breaking.** `read` now returns raw file text in `content`, with the line numbers in the sibling `startLine`/`endLine` fields, instead of rendering `NNN\t` before every line. An anchor copied out of a read used to carry the gutter, so every `edit` built from a read missed and cells wrote string surgery to strip it. A byte-capped page now also ends on a whole line rather than a fragment that reads like an anchor.
- **Breaking.** `grep` results are match-centric: `limit` counts matches, each hit carries the `before`/`after` context that belongs to it, every context line belongs to exactly one hit, and a hit can no longer be dropped to make room for context. The flat `{file, line, text, kind}` rows are gone. A metacharacter pattern that finds nothing is retried as a literal, with `retriedAsLiteral` set.
- **Breaking.** `edit` matches its anchor byte-exactly or fails, and reports the file's real text at the nearest region with its line range. The tolerant apply cascade (trailing whitespace, then collapsed whitespace) is gone from the apply path and survives only as that diagnosis: a match that is not the caller's bytes is an edit nobody inspected, which silently dedented a guard on one instance and corrupted a file on another. `edit` also returns the applied hunk, and `edit`, `write` and `apply_patch` all restore permission bits a host write moved.
- Documented Bash's `stdoutTruncated`/`stderrTruncated` flags as the wire convention `@smthrs/harness/TruncatedOutput` reads, and stated in each stream's description that a truncated capture is a fragment that must not be written to a file.
- Allowed hermetic Bash invocations to use the resolved base directory as their working directory without declaring it as a read.
- Exempted `/dev/*` from the hermetic Bash path scan; process plumbing is not a workspace effect.

### Fixed

- **Breaking.** Closed three independent bypasses in the hermetic pre-check, each on its own sufficient to defeat it. A newline is now a command boundary, so `rm` on line two of a `script` is checked against `writes` instead of being classified under line one's command, and a leading `env`/`sudo`/`nice`/`xargs` wrapper no longer lends its own read classification to the command it wraps. Every path token and every declared entry is resolved before comparison, so `/work/../outside/secret.txt` is no longer inside `reads: ["/work"]` and `/dev/../etc/passwd` is checked as `/etc/passwd` rather than dropped as process plumbing. A blank entry in `reads`/`writes` no longer grants every absolute path, `"/"` now means the whole filesystem rather than nothing, and both fields reject the empty string at decode time.
- Refused a container name that is empty or starts with `-`, and terminated the container argv with `--`, so `container: "--privileged"` can no longer be read as an option by `docker exec`.
- Stopped `Html.decode` from throwing on an out-of-range or surrogate numeric entity, and bounded the element-skipping scan, which took thirty seconds on a two-megabyte page with unclosed `<script>` tags outside every timeout `webfetch` applies.
- Made `test` report a reading only when the runner's own counts and the failure ids it named agree. A summary-only capture (`2 failed`, or `Ran 2 tests` with `FAILED (failures=2)` and no headers) used to come back `parsed: true` with an empty failure set, which reported every base failure as fixed.
- Gave the `against: "base"` worktree the shape `Checkpoints` already proved it needs: a stale checkout is discarded first, the checkout's git pointer is relative so a container can read it, and the repository's format is restored. One killed run used to break every later baseline permanently.
- Escaped `?` in a fixed-string search, so a literal `foo?` no longer matches `fo` and a bare `?` no longer dies as an unhandled defect instead of a typed failure.
- Counted lines the way `grep` counts them in `read` and `edit`: a file ending in a newline no longer reports one line more than it has, and an empty file reads as an empty page instead of an out-of-range offset.
- Refused a `file:`, `data:` or credential-bearing URL in `fetch`, `http-post` and `webfetch` through one shared guard, and bounded every HTTP response before decoding.
- Made `apply_patch` derive every hunk before writing any of it, so a miss on the third hunk leaves the first two unwritten, and named what had been applied when a write itself fails.
- Made `edit` refuse `expect` under an `oldString` anchor and `replaceAll` under a line span instead of silently ignoring them, and refuse an `endLine` past the end of the file instead of clamping it.
- Made `edit` and `apply_patch` read bytes and refuse a non-UTF-8 file the way `read` does, instead of rewriting the whole file with replacement characters where the invalid bytes were.
- Propagated a permission-restoration failure instead of swallowing it, so a write that moved the mode bits and could not put them back is a failure rather than a success.
- Ordered `ls` by UTF-16 code unit rather than the host's ICU locale, reported a file as `not_a_directory`, and described every entry once before cutting the page, so `offset` addresses the same listing at every page size and a broken symlink no longer fails the whole listing.
- Turned an Exa HTTP error into a distinguishable failure instead of a successful empty search, and bounded the provider request.
- Parsed `rg --files` output as NUL-separated, so a legal filename containing a newline is one path rather than two fabricated ones.
- Reported the truncation notice with the real byte totals, and stopped the cut-repair from eating a replacement character the source itself contained.
- Classified the invalid-command probe in `test` against the text the caller receives, so its evidence line is always quotable from the returned tail.
- Anchored the `Probe` recognisers the module documents as whole-line matchers.
- Bounded the language-server transport: a frame header over 8 KiB and a frame over 8 MiB are refused and resynchronized past, the pending buffer grows by chunks instead of copying itself per chunk, and every outstanding request fails when stdout closes or the child exits.
- Returned the workspace-wide envelope from `Lsp.effectsFor`, which narrowed reads to the queried file while the server reads the whole project.
- Dropped the single-in-progress sentence from `update_plan`'s description, which the schema never enforced.
- Made `edit` report the nearest actual region on a miss, as raw quotable bytes rather than line-number-prefixed text; two benchmark runs burned their whole frame budget on whitespace-guessing loops. Prior art: `reference/opencode` `tool/edit.ts`, where this deviates deliberately by refusing to apply a loose match.

- Stopped `grep` and `glob` walks from descending into version-control, dependency, and cache directories; one `.git` descent held a frame for its whole evaluation ceiling.

- Reported a directory entry whose metadata cannot be read as a plain entry instead of failing the whole `ls` listing.

[Unreleased]: https://github.com/smithersai/smithers/compare/v1.0.0-rc.0...HEAD
[1.0.0-rc.0]: https://github.com/smithersai/smithers/releases/tag/v1.0.0-rc.0
