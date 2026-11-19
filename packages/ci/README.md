# smithers-ci

Fast CI for agents.

This package holds the contracts every part of Smithers CI builds against.
Each part reads and writes these documents and never calls another part
directly, so the parts are built at the same time.

| #  | Contract           | Module                                                               | What it fixes                                                                                  |
| -- | ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1  | Run record         | `RunRecord`                                                          | One run: each target's label, key, time and status, its rerun attempts, and why it was skipped |
| 2  | Plan               | `Plan`                                                               | The targets a change selects, with keys and dependencies                                       |
| 3  | Cache protocol     | [remote caching](../smithers/build/docs/workspace/remote-caching.md) | `/ac` and `/cas` over HTTP. Equal key means equal verdict                                      |
| 4  | CI inventory       | `Inventory`                                                          | What a repository's CI does today, as shell commands                                           |
| 5  | Replay report      | `ReplayReport`                                                       | Past commits run as the baseline, in normal mode and in fast mode, compared                    |
| 6  | Selection          | `Selection`                                                          | Fast mode's entries, scores, settings and metrics, as the Facebook paper defines them          |
| 7  | Command surface    | `Command`                                                            | The commands, flags and exit codes of `smithers-ci`                                            |
| 8  | Shards             | `Shard`                                                              | Which machine runs which target                                                                |
| 9  | Dependency closure | `Closure`                                                            | Every file a set of entry files reaches; one strategy per language                             |
| 10 | Parts              | `Parts`                                                              | The function each part exports, so the command-line program can call it                        |
| 11 | Target map         | `TargetMap`                                                          | Which target each CI step became, written among the generated files                            |

## Contract changes

**Nineteenth round, 2026-11-19.** A replay always ends with a listed exit code and a line (`sci-exit-13`). No
contract changed.

- **A replay removes its directory whatever a step left in it** (`Confine.confine`): Smithers build sets a run's
  machines aside and removes them with a command nobody waits for, and the replay's jail ends that command with the
  build. What it had not removed held Go's read-only module cache, the replay made only its homes and temporary
  directories writable, and removing its directory failed. Everything in the directory is made writable now, but
  the clone of the repository (`Confine.sourceDirectory`): git links its objects to the repository's own files.
- **The program never ends with an exit code of Node's, and never without a line** (`cli/main.vibe`,
  `cli/Stage.ts`): that failed removal ended a replay of spf13/cobra with exit 13 and nothing printed, because the
  program waited for a signal after its work had died. Now an error no part answers for, an error nothing caught,
  and work that still waits when nothing is left that could wake it each end with exit 4 and one line,
  `smithers-ci: replay: stopped without an answer while running normal mode at 3f2a1c9`, with the steps stopped and
  the replay's directory removed. `Signals.Listen` hears `beforeExit`, `uncaughtException` and
  `unhandledRejection` beside the two signals.
- **A replay says where it keeps its copies** (`replay.WorkDirectory`, a service like `Progress`, silent unless
  provided): the program removes that directory when a replay cannot. `Stage.stageOf` reads the stage and the
  commit from a `Progress` line, so a new kind of run needs a line there to be named when it stops.

**Eighteenth round, 2026-11-19.** A failed step's reason is a line the step printed (`sci-mac-fast`). No contract
changed.

- **A step that printed nothing says so in normal mode** (`Failures.printedFailure`): where a line stands before a
  step's script in the generated build file (jobs that run apart, a job's middle step, a step in a directory) and the
  step printed nothing, the reason was a line of the text around the step. On a Mac every job of two or more runs
  apart, so every silent failure there read `__ci_fail "a step that only installs packages ..."`. The end of a
  printed command is now found from the call that runs the step's command, so no line before it is ever output.
- **The shell around a step adds no line of its own** (`src/inventory/Runner.ts`): for a step a signal ended, bash
  wrote `lib.sh: line 201: 22254 Killed: 9 "$@" -c "$__script"` to the step's error output, in the baseline and in
  normal mode. GitHub's runner starts the script itself and writes no such line; now the replay writes none.
- **Each failed step keeps its reason, however many fail** (`Failures.printedLimitOf`): a replay kept the last
  256,000 characters of what `smthrs ci` printed for a commit, about 19 failed steps. With 30 failing jobs, 11 read
  `no reason was given` and had no exit code. It now keeps that much for each target asked for.
- **Another job's line is never a step's reason** (`Results.reasonsIn`): jobs that run at once print between each
  other's lines, and a line one job printed while it ran (`//label: ...`) was read as the output of the failed step
  printed before it.
- **A tool's own framed line stays the step's** (`Results.reasonsIn`): a line that starts with a mark of the frame
  `smthrs` draws, as esbuild's `▲ [WARNING]` and Turborepo's `│ > tsc` do, ended what the step printed, and the
  line that says what failed was lost. Only a line `smthrs` frames ends a failure: a mark alone or with two spaces.
- **A signal that ends a step's shell adds no words** (`Process.runStep`, `Failures.signalExit`): the baseline's
  reason was a slice of the step's command, and normal mode's was `the tool was terminated by SIGKILL`. Both give
  what the step printed, or `it printed nothing`, and the exit code a shell gives for the signal.
  Tests: `test/replay/Reasons.test.ts`, `test/native/Results.test.ts`, `test/replay/Process.test.ts`,
  `test/replay/FailedSteps.test.ts`, `test/cli/failedSteps.test.ts`.

**Seventeenth round, 2026-11-19.** A short CI says what starting costs beside it (`sci-overhead`, decided by the lead).

- **`ReplayReport.startCost`, `ReplayReport.StartCost`** (added, optional): `commitMs`, the baseline's wall time for a
  commit, and `startMs`, the time Smithers build takes to start and to decide what to run for a commit, each a mean
  over the commits the wall times cover. It is present when the start is more than a twentieth of the CI's time for
  a commit and normal mode took longer than the baseline (`Summary.startCostOf`): a CI that came out faster has
  nothing to account for, and google/go-cmp is 1.5 times faster with nothing reused. The text report and the page
  say it on one line; no number changes.
- The comments on `TargetMap` and `TargetMap.Entry` say what the generator writes: `maxJobs` 1 only when two targets
  that are not ordered could write the same files, and one target for two steps that do the same work at the same
  point of two jobs.
- Not a contract: the wall-time benchmarks are the target `//packages/ci:bench`, which a wildcard leaves out.

**Sixteenth round, 2026-11-19.** Fast mode on macOS, with a real model (`sci-mac-fast`).

- **`ReplayCommit.skipped`, `ReplayCommit.model`, `ReplayReport.model`** (added, optional), with the schemas
  `ReplayReport.PredictedSafe` and `ReplayReport.ModelUse`: each target fast mode skipped at a commit, with the
  model's score and reason, and what asking the model cost (`ms`, and `questions` when the part that asks keeps
  count). The time the model took for a commit is now in that commit's `fast.wallMs`, and so in `fastWallMs`: a
  fast-mode run waits for the model before it starts. Before, the report gave fast mode a time that left the model
  out. `withoutFast` takes the two new fields out with `fast`.
- **`Parts.AskedQuestions`, `ReplayParts.asked`** (added, optional): how many questions the model has answered since
  the program started. `src/select` exports `asked` and counts in the step that asks, so an answer that replays
  adds nothing. The replay reads it around each commit's `score`.
- **The text report prints fast mode's numbers.** Test recall, change recall and selection rate with their counts,
  the model's questions and time, and every skipped target: until now only the HTML page had the three numbers.
- **An answer is kept for the rest of the run** (`Score.Kept`, `Score.layerKept` in `src/select`; no contract
  changed): `score` asks only about the feature sets the host holds no answer for. Before, a feature set that came
  back in another change, beside other feature sets, was asked about again. A host that provides no place keeps none.
- **A baseline job's `TMPDIR` is its own where there is no jail** (`src/replay`; no contract changed): on macOS,
  and on Linux without bubblewrap, every baseline job was given the person's own `TMPDIR`. A job found there what
  the job before it left, and a step that passes as a target, which has its own, failed in the baseline.
- **A Mac is told about macOS** (`Reads.inPlainWords`): the line that says steps run without a jail and the line that
  says reads are not recorded named the system `darwin`.
- **`Command.environment.USER`** (added): the program gives the model `USER`. On macOS Claude Code keeps its login in
  the keychain of the user `USER` names, and without it a signed-in Mac was told it had no sign-in.

**2026-11-19, why a step was not reused** (optional additions by `sci-outside-gain`).

- `RunRecord.TargetResult.notReused` and `notStored` (optional): Smithers build's own lines for a target that ran:
  what differed from the stored result, and why this run's result is not stored.
- `ReplayReport.StepNotReused` (`{ step, reason, kept }`) and `RunTotals.notReused` (optional): every step a mode
  ran where an earlier result was not used, with the reason. `kept: false` marks a step whose result is never kept,
  so it runs at every commit. The text report lists them under `steps not reused` with the number of commits.
- `StepNotReused.fix`, `command` and `variantOf` (optional): what a person does about a step that is never kept for
  want of a lockfile (`commit Cargo.lock and this step and the 2 after it can be reused`), the first line of the
  step's command, and the step's name without its matrix variant, by which the report puts the variants of one
  step on one line.
  Tests: `test/contract.test.ts`, `test/replay/Summary.test.ts`, `test/report.test.ts`, `test/cli/notReused.test.ts`.

**Fifteenth round, 2026-11-19.** A run says where its time went (`sci-overhead`).

- **`RunRecord.Parts`, `TargetResult.parts`, `RunRecord.parts`, `RunTotals.parts`** (added, all optional): wall time
  in milliseconds by part (`ms`), and CPU time the same way (`cpuMs`) where the machine's processes can be read.
  Smithers build times the parts of a target's run (`machine`, `putBack`, `check`, `step`, `reads`, `keep`, `store`)
  and of the run itself (`start`, `plan`, `answer`, `machinesRemoved`) and writes them with `--results-file`. A replay
  adds `checkout` and puts the sum of each part, with `rest`, on every commit's normal mode under `--json`.
- Not contracts, and changed with them: a baseline job's checkout, home and temporary directory are removed after
  the run's clock has stopped, and Smithers build no longer waits for the machines it made to be removed: a CI
  machine removes neither. On Linux the CPU time of a step (`RunTotals.cpuMs`) is read from the processes under the
  step four times a second (`Table.under`, the kernel's list of each thread's children). Read from every process of
  the machine every two seconds, it lost what a step's processes used after the last reading: p-limit's baseline
  was reported at 48 s for 74 s used, and a mode lost nothing, because its `smthrs` outlives every step and collects
  their time.

**Fourteenth round, 2026-11-18.** Nothing of Smithers CI is in the checkout a step sees (`sci-clean-tree`).

- **`Command.applyIgnores` is empty.** `apply` adds no line to `.gitignore`: Smithers build keeps its cache outside
  the checkout, so there is nothing to ignore. `apply --check` no longer names `.gitignore`.
- **`Inventory.toolCache` is `{smthrs:cache-directory}/tools`.** A tool's own cache is a directory of Smithers build's
  cache directory, outside the checkout. The value starts with the text Smithers build replaces, in a target's `env`,
  with that directory when the step starts; a key holds the text, never the place.
- **`Command.declarationOf(files)`** (added): the generated file Smithers build reads as the workspace declaration,
  the written one at a place of `applyRefuses`. A replay writes that one file beside its copy of the repository and
  names it to Smithers build (`--workspace-file`). No other generated file is written in a replay.
- **`Command.flags["no-apply-check"]`, `ReplayRequest.applied`, `ReplayReport.appliedMs`** (added): a replay runs
  the newest commit once more, in normal mode, in a copy made as `apply` leaves the repository (the generated files
  written and committed), unless the person passes `--no-apply-check`. A step that passes on the commit's files and
  fails there is a mismatch of normal mode with `Mismatch.cause`: the tool, the file and what to add when the step's
  output names a generated file, else a line that says it fails once those files are committed and lists them. The
  run's time is `appliedMs`, on a line of its own, in no other time.
- Not contracts, and changed with them: a replay's copy holds the commit's files and nothing else. Smithers build's
  cache directory, the compiled code of `smthrs`, the generated workspace file and the run records are beside the
  copy (`--cache-dir`, `--workspace-file`), with no ignore line, exclude entry or index bit. The generated workspace
  declares `S.Cache({ directory: ".flows", outside: true, goBuild: false })`, so `smthrs ci '//...'` keeps its cache in the user's
  cache directory; the generated workflow keeps it in `${{ runner.temp }}/smithers-ci` and saves and restores it from
  there. A setup target writes no marker file.

**Thirteenth round, 2026-11-18 (open).** A promise that changed; made by the runner-variables lane
(`sci-runner-env`), accepted by the lead.

- **Two jobs that start with the same step each run it.** Until `0ebe391f39ae` one target ran such a step for both
  jobs, and a job's first step was told its job only when its script named `GITHUB_JOB`. A runner tells every step
  its job, and one run of a step has one job, so every step is now told it and each job runs its own first step.
  `docs/concepts/modes.md` and `docs/concepts/how-it-works.md` say so, and
  `test/replay/FirstRun.benchmark.test.ts` holds four targets and four installs for two jobs. It costs only where
  nothing can be reused: at a first run, or at a commit that changes a lockfile, N jobs that start with the same
  install run N installs, as the baseline does.
- **`CI` is the runner's.** A step is given `CI=true` whatever the shell that started `smithers-ci` holds, unless
  the workflow, the job or the step sets `CI`. A step's own script finds no variable of the program that runs it:
  the runner text reads `Inventory.eventsVariable` and takes it away, as it does `Inventory.stateVariable`.

**Twelfth round, 2026-11-18 (open).** Asked for by lanes; made by the lead.

- **A job is a machine** (`sci-job-machine`). `Inventory.jobTemporaryVariable` (`SMTHRS_MACHINE_TMP`) names a job's
  own temporary directory to its steps: Smithers build names its machine's, the replay a baseline job's. The
  step runner keeps the job's state there, so no job reads another's and nothing is left when the job ends. The
  generator's `StepTarget.machine` (not a contract) names the machine of every target of a GitHub job, one for
  each matrix variant; a job whose every step is held to the files it names has none. Each job runs its own
  steps: two jobs that start with the same install no longer share one target.
- **`Command.applyRefuses` has a third path**, `.smithers/WORKSPACE.smithers`, between the two it had: the order
  Smithers build looks. A plain workspace file an owner wrote makes the repository one that already builds with
  Smithers build; one `smithers-ci` generated starts with the generated mark and does not (`sci-generated-files`).
- **Exit 3's sentence** (`Command.exitCodeHelp.unsupported`) is now "The repository uses something Smithers CI cannot
  run, or its CI does not pass on this machine." (`sci-fail-reason`).
- **The target map is in no repository.** The comments on `TargetMap` and `applyRefuses` say what the build does: the
  generator returns the map marked `written: false`, and `apply` removes the files an earlier version wrote.
- **A job that fails here is left out, not the measurement** (`sci-replay-robust`): a trial baseline at the newest
  commit; a job that fails it is listed `fails-here` with its first error line and run in neither way; the report
  says how many jobs the number covers. A step that uses no CPU and prints nothing for 10 minutes fails.
- **One wording for fast mode** (`sci-native-parity`): "the model that predicts which tests a change cannot break".
  No page or message says judge, scorer, scored or rows.
- **Never a stale pass** (`sci-never-stale`): Smithers build measures a target's declared inputs again when it starts,
  and `smithers-ci apply --check` fails when the generated files no longer match the repository.
- **A replay starts warm** (`sci-warm-start`). Before the first counted commit, every way (the baseline, normal
  mode and fast mode) runs once at the parent of the oldest replayed commit and fills what it keeps between
  commits, as a CI run has the caches of the run before it. That run is not in the speedup; `ReplayReport.firstRun`
  carries its commit and its time per way (optional) and the report prints it as the first run. `--cold` counts
  from an empty cache, and so does a replay whose oldest commit has no commit before it, or none with a CI that
  runs here: `ReplayReport.cold` then says why. The baseline's first run is the run that finds what passes here
  (`ReplayRequest.trial`): a job that fails it runs once more at the newest commit, and one that fails again is
  left out, its `fails-here` reason ending in the commits, as in `no docker here (at 3f2a1c9 and 8d1e0b2)`. Added:
  `ReplayReport.FirstRun`, `ReplayReport.firstRun`, `ReplayReport.cold`, `ReplayRequest.warm`,
  `Command.flags.cold`. Measured cause: on needlefish's five commits the cold count is 1.67 and the count with the
  cache of the commit before is 2.5.
- **A failure costs one rerun** (`sci-warm-start`). A failed step runs once more, not twice, and not at all when
  the same step failed with the same exit code and first error line in the same way's run of the commit before or
  in the first run. `--reruns <n>` sets the number (`Command.flags.reruns`, `ReplayRequest.reruns`); 0 turns it
  off. `ReplayReport.reruns` (`{ count, ms }`, optional) says how many steps ran again and how long that took,
  which is in no other time. Measured cause: on eliza a failed step cost three runs of its 25-minute job, in each
  way.
- **No speedup beside a wrong result** (`sci-warm-start`, the second reviewer's finding). A report where normal
  mode's result differs from the baseline's at any commit has `speedup` 0 over 0 commits and prints none: it
  leads with the number of mismatches and what to do. One rule, in `Summary.reportOf`. A failure fast mode skipped
  is counted in its recall and takes no number away.
- **What the first run leaves out is in plain sight** (`sci-warm-start`, the second reviewer's finding). A job left
  out as `fails-here` is compared in no way, so its reason now holds the step that failed, its exit code, the first
  line of its error and the commits; the headline says the share (`over 3 of 5 jobs`, `ReplayReport.jobs`); and
  when the first run leaves out half or more of the jobs that could run here, the replay fails `unsupported`
  (exit 3) with each of them and why, and prints no speedup. `--no-trial` compares every job.
- **CPU time beside wall time** (`sci-warm-start`). `RunTotals.cpuMs` (optional) is the CPU time a run's steps
  used, every process they started included, over the run its wall time covers; `ReplayReport.baselineCpuMs`,
  `normalCpuMs` and `fastCpuMs` (optional) add it up over the commits the wall times cover. The report prints one
  line. A step's CPU time is not handed up to the replay (a jail keeps it), so the replay reads the machine's
  processes while a step runs; a machine whose processes cannot be read has no CPU time in its report.
- **An install under the step's own home is not a machine change** (`sci-replay-robust`): `go install`,
  `cargo install`, `pip install --user` and the like, on a host where steps run in the jail. `changes-machine` stays
  for what needs root or writes outside the checkout and the home, and on a host with no jail.

**Eleventh round, 2026-11-18 (open).** Decisions from the ship review. Each is built by the lane named.

- **No speedup over a commit whose results differ** (`sci-fail-reason`). A commit enters the speedup only when the
  baseline passed and the mode's result equals the baseline's for every step. The report says how many commits the
  number covers, and prints no speedup when it covers none. `ReplayReport.speedup` becomes optional. Measured cause:
  on refcell/needlefish the baseline passed at five commits, normal mode failed at all five in 20 seconds, and the
  report said `speedup 130`.
- **A failure has a name and a reason** (`sci-fail-reason`): step, exit code and first error line in every report;
  a baseline that never passes prints no speedup and exits 3.
- **A step never sees the person's home, cannot write outside the copy, and cannot push** (`sci-step-jail`).
- **Fast mode checks its model before any work, and a model failure mid-run keeps the normal-mode report**
  (`sci-fast-preflight`).
- **A called workflow is CI when a push or pull-request workflow calls it**, and a job whose unreplayed need gives
  it no outputs is replayed (`sci-eliza`).
- **A variant whose needs are in another leg runs in the needed job's leg** (`sci-leftovers`).

Newest first. A part built before a change adopts it before it lands again.

**2026-11-18, a script that runs other scripts** (optional additions by the script-split lane):

- `Step.inOrder` (optional): a step split from a command that ran its parts one after another and stopped at the
  first that failed, as a script that is `npm run lint && npm run types` does. The generator keeps the order of
  steps with the same `from` and `inOrder`: each waits for the one before it, so a part after a failed one does not
  run. Steps with the same `from` and no `inOrder` stand side by side, as before.
- `Step.whole` (optional): why a step that runs a script made of several commands was left as one step, as a
  feature and a detail. `Reasons.wholeScript` holds the sentence of each feature and `Reasons.wholeScriptSentence`
  gives the line; a test holds them to the table in `docs/concepts/splitting.md`.
- `TargetMap.Entry.part` (optional) and `TargetMap.partsOf(map)`: the part of a split step a target runs (a package,
  a build step, a script), which the generator writes from the step's id. The replay names a failed target by it:
  `Check (check:lint)` where it said `Check`.
- Tests: `test/contract.test.ts`, `test/generate.test.ts` "keeps the order of steps split from a command that ran its
  parts in order", `test/decompose/Script.test.ts`, `test/replay/Summary.test.ts`.

**2026-11-18, a runner's variables** (additive, by the runner-variables lane):

- Contract 4: `Inventory.runVariables`, the variables a run gives every step that are another at every run
  (`GITHUB_SHA`, `GITHUB_WORKFLOW_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`), and
  `Inventory.runValues(commit, count)`, what a replay gives the steps of one commit under those names.
- Contract 4: `Inventory.events` (optional), the event file of each event a replay can stand for, with
  `Inventory.commitMark` and `Inventory.parentMark` where the commit and its first parent go;
  `Inventory.eventFiles(events, commit, parent)` fills them in; `Inventory.eventsVariable` (`SMITHERS_CI_EVENTS`)
  names the directory a replay wrote them to. `Inventory.noParent` is what an event names before the first commit.
- Contract 4: `Inventory.givenTo(script, given)`, what a step is given of a run's variables: all of them with
  runner text, else the ones its script names as `$NAME`. A baseline gives a step what its target passes on.
- Not a contract, and changed with it: every step of a workflow is given every default variable of a GitHub
  runner. A generated target passes on what a run gives with its value out of the target's key (Smithers build's
  `observe: { env }`, or `given` for a step held to its inputs), so a result is reused at another commit unless
  its run used the variable. A step is told its job always, so two jobs that start with the same step each run it.

**2026-11-18, what a replay measures on a machine where part of the CI cannot pass** (optional additions by the
replay lane):

- `ReplayRequest.trial`: the baseline runs once at the newest commit first, and only what passes is replayed.
  `ReplayRequest.stallMinutes`: how long a step may use no CPU and print nothing. `Command.flags` gains `no-trial` and
  `stall-minutes`.
- `Inventory.failsHere` (`fails-here`), `FailedHere`, `withoutFailedHere` and `variantsFailedHere`: a job, or one
  matrix variant of it, that failed in that run is left out of `ci`, and listed with the first line of its error. The
  inventory `apply` reads never has them, so `apply` still writes the job.
- `ReplayReport.jobs` (`{ replayed, total }`) says how many jobs the numbers cover. `ReplayReport.trialMs` is how long
  that run took, which is in no other time.

**2026-11-18, generated files that go stale** (additive, by the `sci-never-stale` lane):

- Contract 7: the flag `check` on `apply`. `apply --check` writes nothing, prints one line for each file `apply` would
  change (`<path> is out of date: run smithers-ci apply`), and exits 1, or 0 when nothing would change.
  `exitCodeHelp.mismatch` also names it. It compares what `apply` would write, from the same code, byte for byte.
- Not a contract, and changed with it: the generated workflow runs `smithers-ci apply --check` right after the
  checkout and Node, so a commit that adds a package or a test file the generated files do not list fails there.

**2026-11-18, fourteenth round** (the needlefish lane: steps one build ran at the same time still do):

- `Step.atOnce` (optional): a step split from a command that ran its parts at the same time in one working tree, as
  `zig build test` runs the named steps it groups. The generator lets targets of one such command (same `from`, job
  and variant) run at once; every other pair of targets that can write the tree still makes the run one at a time
  (`TargetMap.maxJobs` 1). Before, ten steps split from one `zig build test` ran one after another where Zig ran
  ten test binaries at once. Tests: `test/generate.test.ts` "runs at once the steps split from a command that ran
  them at once", `test/decompose/zig.smthrs.test.vibe`.

**2026-11-18, thirteenth round** (optional additions by the generated-files lane, so a repository's own tools never read
a generated file as one of theirs):

- `GeneratedFile.written` (optional) and `Parts.writtenFiles(files)`: `written: false` marks a document the program
  reads from the generated list and no run of the generated CI needs. The target map is one. `apply` and a replay
  write every file but those, so `.smithers/ci-targets.json` is no longer in a repository.
- `Mismatch.cause` (optional): one line for a step that passed in the baseline and failed in a mode over a file
  Smithers CI wrote. It names the tool that read the file, the file, and what to add to that tool's ignore list. The
  mismatch still counts. The replay fills it from what the failed target printed; the report prints it under the
  mismatch.
- Not contracts, and changed with them: the generator writes the workspace and every target as one file,
  `.smithers/WORKSPACE.smithers`, and nothing at the repository's root. `Render.packagePath` is that file.

**2026-11-18, a replay leaves the machine alone** (additive, by the no-sudo lane):

- Contract 4: the feature `changesMachine` (`changes-machine`), a blocker the reader writes for a job with a step that
  changes the machine. `reasonsText` shows its details.
- Contract 7: the flag `allow-root`. `exitCodeHelp.usage` also names a replay as root without it.

**2026-11-18, no container daemon** (additive, by the second jail lane):

- `Inventory.docker` is the feature of a job with a step that starts `docker`, `docker compose`, `docker-compose`,
  `podman` or `nerdctl`. The reader writes it, so such a job is in no `Ci`. `Inventory.allowingDocker(inventory)`
  returns the inventory without that reason. `reasonsText` shows its detail, as in `docker (runs docker compose)`,
  and `Reasons.reasons.docker` is its sentence, which names the programs and the flag that replays the job.
- `ReplayRequest.allowDocker` (optional): the replay reads with `allowingDocker`, and its steps may reach a container
  daemon. Without it no step does: a stand-in refuses where `docker` is, `DOCKER_HOST` is not passed, and a jailed
  step finds the daemons' sockets empty.
- `Command.flags["allow-docker"]`, on `smithers-ci`, `replay` and `apply`.

**2026-11-18, failures have names** (additive, by the replay's failure lane):

- `TargetResult.exitCode` and `TargetResult.command` say how a failed target's command ended.
- `RunTotals.failures` lists each failed step as a `StepFailure`: `step`, `reason`, `exitCode`, `command`.
- `ReplayReport.speedupCommits` counts the commits the speedup covers. `speedup` and the three wall times now cover
  only commits whose baseline passed; a report without the field covers every commit.
- A replay where no step passes at any commit fails `unsupported` (exit 3) for generated targets too.

**2026-11-18, twelfth round** (the eliza lane: a GitHub Actions step is run as a runner runs it; every change adds
and none removes):

- `Step.runner` (optional): shell text that runs the step's `command` the way its CI's runner does. It gives the
  runner's variables, loads what earlier steps wrote to `GITHUB_ENV` and `GITHUB_PATH`, decides the step's `if:`,
  and fills in what `${{ }}` in the command stands for while the job runs. It defines the function
  `Inventory.runnerEntry`. The importer writes it for every GitHub Actions step.
- `Inventory.script(step, unit?)` is the text `Inventory.shell` runs for a step: its command, or its runner text
  followed by `runnerEntry` with the command as one quoted word. The baseline and the generator both run it, so a
  step with runner text does the same thing on each side. A part that copies a step, as the splitter does, keeps
  `runner`. Two lines before the runner text tell it what only its caller knows: `unit`, the job a step is run
  for, which a caller gives where jobs run at once in one checkout, as the baseline does; and whether the step was
  split from another (`Step.from`).
- `Inventory.withVariant` also fills matrix values into `runner`.
- `Inventory.conditionFalse` (`condition-false`) joins `harmless`: a step whose `if:` is false for the event a
  replay stands for is left out and listed, and its job still runs.
- `Inventory.commitNote` and `Inventory.readsCommit(step)`: runner text holds the note when its step reads the
  commit it runs at, or that commit's parent. The generator holds a step with runner text to its inputs only when
  it is the first step of its job and does not read the commit: a later step reads what earlier steps left for
  the job, which no input names, and a step that reads the commit has a verdict of that commit only.
- The runner text of a job's first step names no job unless the step asks for `GITHUB_JOB`, `RUNNER_TEMP` or
  `RUNNER_TOOL_CACHE`. Two jobs that start with the same step so have the same first step, and the generator
  still runs it once for both: each job's second step starts the job's own state from a copy of what it left. A
  first step that asks for one of the three is its job's alone, and every step of the job has one `RUNNER_TEMP`.
  A step that names none of them and still uses `RUNNER_TEMP`, through a program it starts, writes into a
  directory the job's later steps find a copy of, not the directory itself.
- Only a step that reads the commit is given `GITHUB_SHA` and `GITHUB_EVENT_PATH`, and only it asks git. Every
  other step reads the files it opens and what earlier steps of its job left, and nothing that differs from one
  run to the next. So a step the generator has observed (`observe` of `Shell.Test`) is reused until one of those
  changes: `test/cli/observedRunner.test.ts` replays that under `strace`. The only step of a job leaves no state.
- Steps split from one step each carry that step's runner text. The ones split from a job's second step share the
  job's state: each finds what the ones before it wrote to `GITHUB_ENV`, `GITHUB_OUTPUT` and `RUNNER_TEMP`, as long
  as they run one after another, which the generator sees to. The ones split from a job's first step each start
  the state anew, as a first step does, so a later step finds what the last of them wrote and not what the others
  did. The splitter should leave whole a first step whose script names `GITHUB_ENV`, `GITHUB_OUTPUT`,
  `GITHUB_PATH` or `RUNNER_TEMP`.
- A job's state is under `/tmp/smithers-ci-runner-<uid>`, one directory for what a shared first step left and one
  for each job. A step never removes a state but its own and those of checkouts that are gone, and it reads
  nothing there that differs from one run to the next. A job on a machine of its own (`StepTarget.machine`) keeps
  its state in the job's own temporary directory, named by `SMTHRS_MACHINE_TMP`
  (`Inventory.jobTemporaryVariable`): Smithers build names its machine's and removes it with the machine, and
  the replay names a baseline job's and removes it when the job ends.
- `MachineChanges.withInstalled` removes from a job the steps that only install packages the machine has. The
  runner text of the other steps does not count them: each is the job's first, second or later step with those
  steps or without. Such a step runs on a copy of what the steps before it left and leaves nothing; nothing may
  read its `outputs` or `outcome`. Any other code that removes a step from a job breaks the job: a step's runner
  text knows its place.
- `Inventory.runnerSoftware`: the variables by which a GitHub runner tells a step where its Android SDK, Java versions,
  browser drivers, Conda and vcpkg are. A step with runner text is given those the machine sets, in the baseline and
  as a target, unless it sets one itself.
- `Inventory.stateVariable` (`SMITHERS_CI_STATE`): the variable a baseline step is told by where files are kept
  from one run to the next, as a cache step keeps them. The replay sets it to a directory of its own, outside every
  checkout and every home. A generated target is told through Smithers build's cache directory, written into its
  text. The runner text takes the variable away before a step's own script starts.
- A `command` may hold a `${{ }}` that is not a matrix value, such as `${{ steps.diff.outputs.base }}`: the runner
  text replaces it when the step runs. The generator writes only matrix values into a step that has runner text,
  and passes it no runner variable of the machine: the runner text sets them all.

**2026-11-18, eleventh round** (the needlefish lane, for a step that runs `zig build`):

- `Inventory.toolCache` (`.flows/tools`): where a tool a step starts keeps its own cache between runs. A step names
  a directory under it in its `env`; the generated workflow then saves it with the results. What a step reads and
  writes there is no part of what an observed step read.
- `Step.tools` and `Step.sealed`, added earlier the same day, are gone. They held a Zig build to its closure; Zig's
  tests write where they start, so a Zig step names no inputs and is observed.
- `Parts.Decompose` no longer takes the Zig closures: `splitWith({ zigGroups })` reads only the named steps a build
  step groups (`Zig.groups` of `src/closure/zig`).

**2026-11-18, tenth round** (the independent review's 31 findings, fixed by the replay, apply and generate lanes):

- **Contract 4, which jobs run.** `blockers` adds a `secret` entry for each step that receives a secret, so a `Ci`
  never holds such a step. New features `releaseTrigger` and `writePermission`, neither in `harmless`. The importer
  writes `release-trigger` only when a push limited to `tags` is the workflow's one change trigger.
- **Contract 4, what a replay leaves out.** `Host` and `hostOf` moved here from the generator, with the feature
  `otherSystem`. `noTarget` names a job with a step that has no target. `noCommand`: `notReplayed` lists a CI job whose
  every step was a host action. `notRead(inventory)` is `unsupported` without the `smithersBuild` entry.
  `uncommittedChanges` is the feature of a working tree that differs from its commit.
- **Contract 4, how steps run.** `stepTimeoutHours` (6) limits a baseline step and a generated target. `treeOf(job)`
  and `treeOrder(jobs)` name a shared working tree and its order, and **`Inventory.ci` returns the jobs of one shared
  tree in the order they run**: `ci: build test` gives `build`, then `test`. A part that relied on a `Ci` keeping
  inventory order for Justfile recipes or `package.json` scripts sees a different order.
- **Contract 4, what steps and tools declare.** `Step.outputs` (optional): the paths and globs a step writes. A step
  after it in one working tree stays narrowed only when every earlier step has `inputs` and `outputs`.
  `Toolchain.version` may hold `${{ matrix.<key> }}`, which `expand` fills per variant. `Toolchain.job` (optional)
  is the id of the job whose step sets the tool up, and `Toolchain.action` (optional) is that step's `uses` value;
  without `job` the tool is the repository's.
- **Contract 5.** `flaky`, `notRead` and `notReplayedCommits` are optional keys of the report. In a `Mismatch`, `pass`
  and `flaky` agree, and a split step is a mismatch when the mode never reported one of its targets.
- **Contract 1.** `Attempt`: a failed target reruns up to the limit the program sets (two) or until it passes.
- **Contract 7.** `flags.cache.help` says a cache URL holds no user name or password. `exitCodeHelp.mismatch` says a
  flaky target does not make the exit code 1. The comment on `applyRefuses` says `apply` checks every path before it
  writes any; the one on `applyIgnores` says `apply` prints what it adds.
- **Contract 10.** `RunReplay` reads each commit's inventory from that commit's tree. The newest commit's CI must be
  replayable; an older commit whose CI is not is listed in `notReplayedCommits`.
- **Open (owner: `src/decompose`).** The splitter fills no `Step.outputs` until a Smithers build target can declare an
  installed tree as an output and a confined step can write.

**2026-11-17, ninth round** (asked for by the native lane):

- `--targets` (`Command.flags.targets`) names Smithers build patterns to replay, on `smithers-ci` and `replay`. The
  program parses it and passes `ReplayRequest.targets`. On a repository with no workspace of its own, a replay given
  `targets` fails `unsupported` (exit 3); it never ignores the flag.
- `ReplayReport.targets` holds the patterns replayed, present only when the repository's own targets were replayed.
  The native lane may edit `src/report` to show it above the speedup.
- `Inventory.smithersBuild` and `Inventory.ownWorkspace(inventory)` name a repository that already builds with
  Smithers build. `Command.applyRefuses` is now the two workspace files; `apply` refuses when either exists and never
  writes over a build file it did not generate.

**2026-11-17, eighth round** (the replay runs split steps):

- `Inventory.withSteps(ci, steps)` returns a `Ci` with the steps of each job replaced. `split` uses it in place of
  asserting the type; `Inventory.ci` must not be called on its own result.
- `TargetMap.labelOf` is removed. `labelsOf` is the one accessor: one label, or several for a split step.
- The replay calls `parts.decompose` before `parts.files`. The baseline runs the unsplit steps; a split step is
  compared, under its own id, with `RunRecord.combine` of the verdicts of its targets.
- `Inventory.refusal(inventory)` words every "nothing of this CI can be run" answer; `apply` and the replay use it.
- The replay says what it runs through the `Progress` service of `src/replay` (silent unless provided).

**2026-11-17, seventh round** (asked for by the splitter and replay lanes):

- `Step.inputs` are globs as Smithers build's `glob` reads them. **A target that declares its step's inputs runs
  under Smithers build's enforced read sandbox**: an undeclared read then fails the target instead of passing
  stale. A step with inputs still gets `sandbox: "none"` when its target declares no inputs, and then declares the
  whole repository: a step a later step relies on (it always runs and its result is never reused), a step that
  follows another step in its working tree (until that step has `outputs`, tenth round), and every step when
  `PACKAGE.ts` would pass 1 MiB.
- Contract 2's comment now says what `smthrs ci --plan` really prints; the replay's `planOfPrinted` converts it.
- Not adopted yet: a flag that names a repository's own wrapper script as standing for `turbo`. It waits until a
  repository's CI passes the sixth-round rule and only the wrapper stops a split.
- `land.sh` now refuses a push whose lockfile no longer installs: three commits reached `main` with a broken
  `pnpm-lock.yaml` from concurrent rebases.

**2026-11-17, sixth round** (found by the lead reading eliza's 15 CI jobs: one posts to the GitHub API, most read
`$RUNNER_TEMP` or `$GITHUB_OUTPUT`, and none of that was stopping a run):

- **A job that cannot be reproduced is never run.** `Inventory.isRunnable` is now: the job has a step and no
  blocker. A blocker is any unsupported feature outside `Inventory.harmless` (`host-action`, `trigger-filter`).
  The importer writes `host-action` for checkout, toolchain setup, cache and upload-artifact steps, and `uses` for
  every other action.
- **`Inventory.Ci` is a branded type that only `Inventory.ci` returns.** `GenerateFiles` and `Decompose` accept
  nothing else. If your code no longer compiles, call `Inventory.ci(inventory)` and delete your own rule for which
  jobs run. The replay runs the baseline from the same value.
- A job is left out together with every job that needs it (reason `needs`). In a `Ci`, every job has a step and
  every need names a job in it: a need on a job that only groups others becomes a need on the jobs it groups. The
  replay (`src/replay`) uses it and no longer has a rule of its own.
- `ReplayReport.notReplayed` lists each CI job left out with its reasons (`Inventory.notReplayed(inventory)` at the
  newest commit). The replay fills it; the report shows it above the speedup. With every job left out, the program
  exits `unsupported` and prints the list.

**2026-11-17, fifth round** (asked for by the program's lane):

- **Fast mode's judge is the judge `smthrs` binds:** `NodeControl.layerSeatEvaluator(process.env)` from
  `@smthrs/cli`. It is Jev with `AI_GATEWAY_API_KEY`, else the model the machine is signed in to. `Command.environment`
  lists the key. The program adds no variable of its own for the model, and `smithers-ci` depends on `@smthrs/cli`,
  which it also needs to run `smthrs`.
- Fast mode's ledger and the judge's flow steps stay in memory for one run. The default command writes nothing
  outside its temporary copies.

**2026-11-17, fourth round** (found by the lead running the parts together on needlefish and eliza):

- **What is CI.** An inventory lists everything a repository can run; eliza's holds 1,897 jobs, among them
  `db:cloud:migrate` and `ios:device:deploy`. `Inventory.ci(inventory)` is the only thing the baseline, the generator
  and the replay run or turn into targets: jobs a push, pull request or merge group triggers, or else the root `ci`
  recipe, each with what it needs. Empty means the program exits `unsupported`.
- **Splitting a step.** New part `src/decompose` exports `split` (`Parts.Decompose`): a step that runs a task over a
  whole workspace becomes one step per package, with `Step.inputs` and `Step.from`. `ReplayParts` gains an optional
  `decompose`; without it the CI is run unsplit.
- The generator declares `Step.inputs` as a target's inputs when present, and writes one target map entry per split
  step, naming `Step.from`. The replay compares a step with `RunRecord.combine` of `TargetMap.labelsOf`.

**2026-11-17, third round** (asked for by the Zig, fast-mode and generator lanes):

- Every pure function in a contract is marked `@throws {never}`, so VibeLang code calls it directly.
- `Closure.directories` (optional): directories read whole; `isAffectedBy` counts any file under one. An entry may
  be a build step's name. A cache key built from a closure includes `packages`.
- `Parts.CloseEntries`: what a language's closure strategy exports as `close`. `Failure.part` gains `closure`.
- `Parts.BuildRows` takes the commit's plan as an optional third argument.
- `Selection.Row.at` (optional), `Selection.unreachable` (-1) for `graphDistance`, and `RunRecord.TargetResult.tests`
  (optional). `Selection.metrics` gives the same numbers in linear time.
- `TargetMap.maxJobs` (optional): a caller never runs more generated targets at once. The generator writes 1.
- `Command.applyRefuses` and `Command.applyIgnores`: when `apply` exits `unsupported`, and what it adds to `.gitignore`.

**2026-11-17, second round** (asked for by the inventory, replay, shard, docs and command-line lanes):

- `Parts.RunReplay` takes the parts as a second argument, `ReplayParts`. `ReplayRequest.settings` is optional;
  `Selection.defaultSettings` applies without it.
- `Parts.GenerateFiles` takes optional `GenerateOptions` (`cache`). The generator also returns the target map
  (contract 11) at `TargetMap.path`; the replay finds a step's target with `TargetMap.labelOf`.
- `Command`: exit code `failed` (4), `failureExitCodes`, `exitCodeHelp`, `syntax`, `documents`, `environment`.
- `Inventory`: a step runs as `Inventory.shell` then its command; `withVariant` fills `${{ matrix.<key> }}`;
  `Step.secretEnv` and `Inventory.unsupported` are optional; a job that fails `isRunnable` is never run.
- `Shard.assign` balances by measured duration. `shardOf` is the rule when nothing is measured.

## Rules

- A contract changes in one commit that also updates its example documents in
  `test/fixtures` and its tests. No part works around a contract.
- `run-record.rc18-workspace-targets.json` and `plan.generate-package.json`
  are recorded from real runs. The other example documents were written by
  hand to show the shape.
- A target that fast mode skips has `status: "skipped"` and
  `skipReason: "predicted-safe"`. It is never reported as passed and never
  written to a cache.
- A dependency closure with an import it could not follow is affected by
  every change.
- A secret appears in an inventory by name only.

## Where each part lives

| Directory       | Part                                                       |
| --------------- | ---------------------------------------------------------- |
| `src/contract`  | The contracts. Changed only as the first rule says         |
| `src/inventory` | Reads a repository's CI into contract 4                    |
| `src/generate`  | Writes Smithers targets from contract 4                    |
| `src/replay`    | Runs past commits and writes contract 5                    |
| `src/report`    | Renders contract 5 for a terminal and as HTML              |
| `src/select`    | Fast mode: builds its entries, asks the model, measures    |
| `src/decompose` | Splits a coarse CI step into per-package steps             |
| `src/closure`   | Contract 9, one strategy per language                      |
| `src/apply`     | Checks every generated path, and what writing would change |
| `src/native`    | Replays a repository that already builds with Smithers     |
| `src/cli`       | The `smithers-ci` program                                  |
