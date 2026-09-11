# The finished architecture on the same 45 (r97)

Measured 2026-08-24 18:26:51Z to 19:47:53Z, 81 minutes wall, three in flight.
This is the first wave in which the persistent realm is the **only** cell
surface there is, and the first to carry checkpoints. Three commits define the
subject and all three are ancestors of the pinned HEAD:

| commit | what it landed |
| --- | --- |
| `e57dd620c` | **checkpoints as values** — `ctx.base`, `ctx.checkpoint()`, `ctx.call(flow, input, { at })`, so a fails-before proof never costs the work it proves |
| `5328d7f7f` | **the filing surface leaves the tree** — `cellMode`, `Cell.Mode`, `FLOWS_CELL_MODE`, the per-frame execution path, and the transition's `state`/`context`/`render`/`recall` are deleted |
| `0bc51fdf4` | **the nested-wait deadlock is fixed** — `waitForZero` was waiting on its own enclosing region inside an uninterruptible finalizer, which wedged two `r96repl` runs forever |

**The wave settles the two things it was run to settle, and neither of them is
the money.** Checkpoint adoption is near-total and it removed the pathology it
was built for: **44 of 45 runs take a baseline against `ctx.base`, and the lane
contains zero identical-mutation repeats and zero `git checkout --`
self-reverts** — against 7 repeats in `r96repl` and 4 self-reverts in `r95repl`.
Guarded completion held at the ceiling it reached last draw: **93 of 94
completions behind a check (98.9 %)**, and **45 of 45 runs reached a terminal
transition** where every earlier lane lost one.

**On the three keys it is a tie that costs money.** Against `r96repl`: **+1
verdict, +7.5 % on money, −2.9 % on the agent's own wall clock**. Against
`r95repl`, the cheapest realm draw: **0 verdicts, +21.3 % on money, +0.2 % on
wall clock**. The one gained verdict is `django__django-13346`, which `r96repl`
lost to a provider refusal rather than to a harness, so on harness merit the
verdict count is unmoved for a fourth draw running.

**Against the r90 baseline the standing bar is met, and by a wide margin.**
`compare-runs.mjs` reads the two ledgers: resolved **33 → 34** scored (35 → 36
raw), cost **$37.37 → $24.70** (−33.9 %), agent wall **15,707 s → 5,178 s**
(−67.0 %). Cheaper *and* faster at more resolved.

**Against sealed codex at matched high effort the honest sentence is one line:**
on the 34 scored instances codex did not breach the seal on, the two arms
resolve **29 apiece with no disagreement in either direction**, and flows gets
there on **$18.86 measured against $27.25 derived** and **4,225 s of agent wall
against 4,791 s**. Codex's headline +4 is four instances it fetched the upstream
fix for before writing a patch.

## What moved since the last draw

`r96repl` was the last measurement of the realm and it ran with a knob
(`FLOWS_CELL_MODE`) that could still select a filing surface. That knob and that
surface are gone. What a wave changes now is the harness, and there is nothing
to arm.

| | `r96repl` (2026-08-24 01:49Z) | **`r97`** |
| --- | --- | --- |
| surfaces in the tree | two, one selected by `FLOWS_CELL_MODE` | **one, and no selector** |
| `discipline-armed` payload | carries `cellMode: "repl"` | **carries no `cellMode` key at all** |
| rendered `cell-contract` | `sha256:7272668fa108fd06549308cbaab435c13debcee0f544d5ba583108a7809ec0a4`, 8,312 characters | `sha256:70d5375b63f722d12bcad4698b892e2e5041ded5a94ad269f8958ea640c4855e`, **8,517 characters** |
| fails-before proof | undo the edit, re-run, re-apply | **`ctx.call(check, input, { at: ctx.base })`, edit untouched** |
| a nested `wait` | wedges the round forever | parks the run |

The contract moved 8,312 → 8,517 characters on will's checkpoint ruling: the
worked example now edits **first** and takes its baseline against `ctx.base`
afterwards, and rule 9 says in those words never to undo your own edit to
re-prove a baseline. Both numbers are pinned by
`packages/harness/test/CellPrompt.test.ts`, which is green at this subject.

`run-45.sh` was checked for the retired knob before the wave and runs clean
without it: the only surviving mention of `FLOWS_CELL_MODE` anywhere in the rig
is the sentence in `run-45.sh`'s own header saying it selects nothing, and
`lib/repl-evidence.mjs` reading `payload.cellMode ?? "repl"` so the five older
lanes still decode. Every r97 journal's `discipline-armed` row confirms it from
the other side.

**The model authoring surface is still plain JavaScript over `await
ctx.call(name, input)`.** The 2026-08-20 ruling stands; nothing in this wave
tests it, and no arm here has a review step, an audit step, or anything that
knows this is SWE-bench.

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:830a7fe3f29774f8b1f5c99471556da30769fe513efafa527ede25e331251e55` |
| git HEAD at the pin | `0575fca03ad64aca8b464833d384b8d433d3251e` |
| HEAD subject | 🔧 fix(harness,cli): the two places the filing surface is still taught, and the strand's third wake source |
| filing deleted at | `5328d7f7f` (ancestor of HEAD) |
| checkpoints landed at | `e57dd620c` (ancestor of HEAD) |
| nested-wait deadlock fixed at | `0bc51fdf4` (ancestor of HEAD) |
| `packages/harness` marker | `CellTurn.ts` `sha256:b6432e58f448a582586597af83c14d4ef3374ddd34ca4274f9203e6bf69a9ee8` |
| `@smthrs/cli` dist | `sha256:8a8a3d9fe107c74b3a7ca2de6d4a2f5c4aa994bf3c2d3f8e8d380afa6d21f4d5` (11 modules) |
| `@smthrs/cli` src | `sha256:f8fd1a24741be1f3db395ee2bc2d3614e6ef95b23375a423867f239ac1396145` |
| preflight refusals | **two `dirty-subject`** — see the disclosure below |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol` |
| reasoning effort | high (`effortFor` returns `high` with no flow frontmatter and no host option; `lib/write-flow.mjs` writes no `effort:` line) |
| attempts | one per instance |
| per-instance budget | 1200 s |
| in flight | 3 |
| disk gate | 8192 MiB |
| budget gate | $60 |
| discipline, every run | `readOnlyCap 12`, `maxFrames 100`, `approvalChannel false`, `modelCallMs 300000`, `repeatCap 4`, `narrowingCap 1`, `unmovedCap 1`, `unresolvedCap 1`, `calls 64`, `memoryBytes 268435456`, `steps 5e7`, `timeMs 30000`, `callMs 120000`, `totalMs 900000` — **and no `cellMode`** |
| population | the 45 the r90 baseline ledger graded, same seeded draw order, derived by `lib/rerun-queue.mjs` |
| grading | official evaluator, x86_64 images, run id `rerun-r97` |
| ledger completeness | 45 of 45 `graded` then `cleaned`; **no `note` row**, no `journals-crashed/`, no re-run instance |
| subject agreement | one distinct stamp across all 45 `timings/<id>.json`; `node lib/subject.mjs --check` exits 0 at the same stamp after the wave; HEAD unmoved |
| `./verify.sh` | **exits 0** at this subject, 34 sections |

Both denominators are printed on every rate. `lib/excluded.mjs` names
`psf__requests-1766` and `psf__requests-2317`, whose verdicts are statements
about which httpbin the grading container reaches rather than about a harness.
They are excluded for both arms and for every earlier column, they keep their
per-instance rows, and they are in no movement set.

Cost is every attempt, which is what the invoice says. The wall clock compared
is `agentSeconds` — the journal's own span across the agent's frames, summed per
instance. `wallSeconds`, the whole-instance figure, is reported beside it.

### Disclosure — four subject files differ from HEAD, and all six differing lines are no-ops

`preflight.sh` refused to pin this tree with two `dirty-subject` codes:
`@smthrs/agent` at one path and `@smthrs/flow` at three. The wave was pinned with
`SWB_ALLOW_DIRTY_SUBJECT=1`, which is why the `refusals` row above is not
`none`, and the fingerprint records every differing path.

The four files are `packages/agent/src/StandardFlows.ts`,
`packages/flow/src/DurableClock.ts`, `packages/flow/src/DurableDeferred.ts` and
`packages/flow/src/Action/make.ts`. Between them they carry **six** lines, all of
one shape:

```ts
;(globalThis as any).__dbg?.("clock.sleep arming " + clock.name)
```

`__dbg` is assigned in exactly one place in the repository —
`packages/agent/test/WakeRepro.test.ts`, a test file no rig process loads — so in
every one of the 45 wave processes `__dbg` is `undefined` and all six sites are
optional-call no-ops. They are a sibling lane's uncommitted debugging of the
same wake path this wave reports on; they were left alone rather than reverted,
because reverting another lane's work is not a rig procedure. The subject is
therefore behaviourally HEAD `0575fca03`, and the report may not claim a clean
commit. **The subject did not move during the wave**: the same stamp is in all 45
timings and `lib/subject.mjs --check` exits 0 at it afterwards, so every
`flows.sh` invocation in the lane checked itself against one fingerprint or
refused to run.

## The three keys, both denominators

`node n-way.mjs --wave r94=… --wave r95repl=… --wave r96repl=… --wave r97=…`.
Nothing below is recomputed; every column is `compare-runs.mjs`'s own fold of
that lane's ledger.

| | r94 (filing) | r95repl (realm) | r96repl (realm) | **r97 (realm only)** |
| --- | ---: | ---: | ---: | ---: |
| **resolved (scored, 43)** | 34 | 34 | 33 | **34** |
| resolved (raw, 45) | 36 | 36 | 35 | **36** |
| **cost (scored)** | $24.96 | $20.37 | $22.98 | **$24.70** |
| cost (raw) | $25.31 | $21.14 | $23.65 | **$25.52** |
| **agent wall (scored)** | 9,981 s | 5,168 s | 5,331 s | **5,178 s** |
| agent wall (raw) | 10,098 s | 5,434 s | 5,554 s | **5,571 s** |
| instance wall (scored) | 11,120 s | 5,914 s | 14,134 s | **6,151 s** |
| instance wall (raw) | 11,271 s | 6,195 s | 20,077 s | **6,580 s** |
| frames (scored) | 327 | 340 | 258 | **290** |
| frames (raw) | 333 | 358 | 271 | **303** |
| calls (scored) | 1,050 | 761 | 803 | **827** |
| calls per frame (scored) | 3.21 | 2.24 | 3.11 | **2.85** |
| wave wall clock, 3 in flight | 110 min | 97 min | 166 min | **81 min** |

### r97 against the lane it replaces

| | vs `r96repl` (scored 43) | vs `r95repl` (scored 43) | vs `r94` filing (scored 43) |
| --- | ---: | ---: | ---: |
| resolved | **+1** | **0** | **0** |
| cost | **+$1.72 (+7.5 %)** | **+$4.33 (+21.3 %)** | −$0.25 (−1.0 %) |
| agent wall | **−153 s (−2.9 %)** | +10 s (+0.2 %) | **−4,803 s (−48.1 %)** |
| per instance, faster / slower | 17 / 25 | 23 / 20 | 29 / 14 |
| per instance, cheaper / dearer | 21 / 22 | 16 / 27 | 19 / 24 |
| per instance, fewer / more frames | 14 / 20 | 25 / 12 | 13 / 22 |

### Against the r90 baseline the wave exists to beat

`node compare-runs.mjs --rerun fullbench/rerun-r97/manifest.jsonl`:

```
45/45 compared, scored 43 of 45 run, resolved 33 -> 34 (raw 35 -> 36),
cost $37.37 -> $24.70, agent wall 15707 s -> 5178 s
```

−33.9 % on money and −67.0 % on the agent's own wall clock, at one more verdict.
**The standing cheaper-and-faster bar is met against the baseline.** It is not
met against `r95repl`, which remains the cheapest measurement of this population
any lane has produced.

### Read the noise before reading the verdict line

The filing arm's own two draws of one unchanged configuration scored 34 then 31
— three verdicts apart. Every difference in the resolved row above is one
verdict, and all of them sit well inside that spread. **Resolved has been a tie
across four consecutive draws of this population.** What the last three drafts of
the realm have moved is mechanism, not verdict count, and this one is no
different.

Only three instances change verdict anywhere between `r95repl`, `r96repl` and
`r97`:

| instance | r95repl | r96repl | **r97** |
| --- | --- | --- | --- |
| `django__django-13128` | unresolved | resolved | **resolved** |
| `django__django-13346` | resolved | **empty patch** (provider refused the prompt) | **resolved** |
| `sympy__sympy-19495` | resolved | unresolved | **unresolved** |

`r97` differs from `r96repl` on exactly one instance, and that instance's
`r96repl` row is a provider refusal — `flows/model/ModelError: Invalid prompt`
— not a harness outcome. **Netting it out, `r96repl` and `r97` resolve the same
set.**

## Checkpoint adoption

The reading is off the journals. `ctx.checkpoint()` mints a
`control.agent.checkpoint-minted` event; `ctx.base` mints nothing by design (it
is the run's opening tree, free and always present), so its use is read off the
cell source in `control.agent.cell-produced`, where `{ at: ctx.base }` is
written. Both readings can undercount and neither can invent a use.

| | r94 (filing) | r95repl | r96repl | **r97** |
| --- | ---: | ---: | ---: | ---: |
| runs naming `ctx.base` | 0 | 0 | 0 | **44 of 45** |
| cells naming `ctx.base` | 0 | 0 | 0 | **69** |
| runs calling `ctx.checkpoint()` | 0 | 0 | 0 | **0** |
| `checkpoint-minted` events | 0 | 0 | 0 | **0** |
| checkpoint refusals (`checkpoint_unavailable` / `_exhausted` / `_readonly` / `_unsupported`) | 0 | 0 | 0 | **0** |
| **identical-mutation repeat signatures** | 1 | 2 | **7** | **0** |
| **identical-mutation repeat calls** | 1 | 5 | **7** | **0** |
| instances with any such repeat | 1 | 2 | 4 | **0** |
| **`git checkout --` self-reverts** | 0 | **4** | 0 | **0** |
| runs issuing one | 0 | 1 | 0 | **0** |
| information repeats (a re-read of a file already handed over) | 6 | 0 | 0 | **0** |

**The adoption is immediate and near-total.** 44 of the 45 runs took a baseline
against `ctx.base` in the first wave the API existed. The single run that never
named it, `sympy__sympy-18763`, ran three frames and finished; it is unresolved
in both arms and was unresolved before checkpoints existed.

**Nobody minted a checkpoint.** Zero `ctx.checkpoint()` calls in 303 cells. The
free handle answers the whole of the demand the feature was built for, which is
what `e57dd620c`'s own reasoning predicted: the frame that wants a baseline is
almost never the frame that could have foreseen it, so the pin that costs a line
of foresight goes unused and the one that costs nothing gets used 69 times.
`ctx.checkpoint()` is not dead code — it is untested by this wave, which is a
different sentence, and the eight-per-run cap it carries was never approached.

**Zero refusals.** No run hit `checkpoint_readonly` by pointing a writing flow at
a pinned tree, none hit `checkpoint_unavailable`, none exhausted anything. The
teaching landed without the fail-soft paths being exercised at all.

**The pathology the feature was built for is gone, completely.**
`e57dd620c` priced it: on `sympy__sympy-13878` the `r95repl` lane applied one
byte-identical 4,789-character patch five times, four of those applications
preceded by `git checkout -- sympy/stats/crv_types.py`, because a clean
fails-before proof required reverting the very work it was meant to prove. In
`r97` that instance runs 13 frames, reverts nothing, repeats nothing, and
resolves at $1.83. **Across the whole lane there is not one identical-mutation
repeat and not one self-revert of any kind** — no `git checkout --`, no `git
restore`, no `git stash`, no `git reset --hard` — where `r96repl` had 7 repeats
across `django__django-13406`, `django__django-14351`, `django__django-15380`
and `sympy__sympy-13372`.

The shape the contract teaches is the shape the journals contain. From
`pydata__xarray-7393` frame 4, one cell:

```js
const applied = await ctx.call("edit", { … })
const syntaxCheck = await ctx.call("bash", { … })
const before = await ctx.call(verification.flow, verification.input, {at: ctx.base})
const after = await ctx.call(verification.flow, verification.input)
…
ctx.done("…")
```

Edit, then the baseline against the tree the run opened on, then the same check
on the tree the cell just changed, then finish behind the comparison — in one
frame, with the edit never undone.

## Guarded completion

Read by `lib/repl-evidence.mjs`, unchanged since the `r96repl` report: a
completion is **guarded** when `ctx.done` or `ctx.park` sits behind an `if` test,
inside a block an `if` or `else` opens, or after a `&&` or a `?`, read by walking
back through balanced parentheses and braces of literal-masked source. The
reading can miss a real guard and cannot invent one.

| | r95repl | r96repl | **r97** |
| --- | ---: | ---: | ---: |
| runs that reached a terminal transition | 44 of 45 | 44 of 45 | **45 of 45** |
| terminal tags | — | — | **`complete` × 45** |
| **the finishing completion was behind a check** | 11 | 43 | **44** |
| cells that wrote a completion at all | 57 | 82 | **94** |
| of those, guarded | 22 (**39 %**) | 81 (**99 %**) | **93 (98.9 %)** |
| of those, unguarded | 35 | 1 | **1** |
| call-free final frames (raw / scored) | 33 / 31 | 11 / 10 | **11 / 10** |

**99 % held.** One cell in the lane wrote a bare completion —
`django__django-15569` — and it is the same run that accounts for the one
finishing completion not behind a check. Every other completion in 45 runs and
303 cells is behind a test.

**Every run finished.** 45 of 45 reached `complete`, where `r95repl` and
`r96repl` each lost one. All 45 exited 0 and none reached the 1,200 s budget:
the longest agent span in the lane is `sympy__sympy-13878` at 455 s and the
longest whole instance is the same run at 461 s. All 45 produced a non-empty
patch, 394 B to 12,629 B.

The call-free attestation frame is flat at 11 runs, exactly `r96repl`'s count.
It is not the old see-then-attest shape returning: those runs finish behind a
guard written against a value an earlier frame bound and printed, which is the
realm doing its job.

## The wake fix: no evidence in this wave, and that is the finding

**No run in `r97` called the `wait` flow.** Zero `control.agent.cell-call-started`
rows naming it, zero `flows.engine.clock-scheduled` events and zero
`flows.engine.deferred-completed` events across all 45 journals. The wave
therefore contains **no direct evidence that the fix at `0bc51fdf4` works**, and
this report does not claim any.

What it does contain is the absence of the condition that produced the wedge, and
the record of how the two `r96repl` runs got there:

| | r96repl | **r97** |
| --- | ---: | ---: |
| `wait` calls | 2, in `psf__requests-2317` and `pytest-dev__pytest-6197` | **0** |
| of those, settled | 0 | — |
| of those, resumed | 0 | — |
| `clock-scheduled` / `deferred-completed` | 2 / 2 | **0 / 0** |
| runs killed after never waking | **2** | **0** |
| `narrow-only-demanded` refusals | 3, in 3 runs | **5, in 5 runs** |
| of those, recovered and completed | 1 of 3 | **5 of 5** |

Both `r96repl` casualties reached `wait` down one path: a `complete` transition
refused by `control.agent.narrow-only-demanded` — the discipline's
`narrowingCap` demanding one narrowing turn before a run may finish — after which
the run answered by waiting on a long test command instead of narrowing.
`r96repl`'s three refusals were exactly those two plus `astropy__astropy-7166`,
so one of three recovered. In `r97` the refusal fired **more** often — five runs,
`astropy__astropy-14365`, `psf__requests-1766`, `psf__requests-2317`,
`pydata__xarray-7233` and `pydata__xarray-7393` — and **all five narrowed,
completed and were graded**. Both of the instances that hung in `r96repl` ran
clean here: `psf__requests-2317` took the refusal, narrowed, and finished the
whole instance in 321 s; `pytest-dev__pytest-6197` completed in 163 s and
resolved.

The evidence that the deadlock itself is fixed is where `0bc51fdf4` put it and
not in this ledger: cases at the flow-level strand, at the durable park and the
delivered signal in the engine-store, and one whole harness run on the production
durable engine, each failing on the tree before the change, plus `WaitFor`'s
approval wake source added at `0575fca03`. **A benchmark wave that never waits
cannot settle a wake path, and quoting this lane's 45-of-45 completion rate as
proof of the fix would be reading an absence as a measurement.**

## Where the money went

Same committed price table, `openai:gpt-5.6-sol` at $5.00/M uncached input,
$0.50/M cached input, $30.00/M output. Raw, all 45, off `lib/run-cost.mjs`:

| | r94 (filing) | r95repl | r96repl | **r97** |
| --- | ---: | ---: | ---: | ---: |
| input tokens (total) | 3,392,916 | 4,984,761 | 4,696,486 | **5,474,701** |
| of which cached | 2,090,642 | 2,107,406 | 1,543,134 | **1,797,620** |
| cache rate | 61.6 % | 42.3 % | 32.9 % | **32.8 %** |
| output tokens | 591,709 | 190,079 | 237,142 | **207,940** |
| reasoning tokens | 366,191 | 92,177 | 108,505 | **98,337** |
| model calls | 335 | 357 | 271 | **303** |
| output per call | 1,766 | 532 | 875 | **686** |
| uncached input | $6.51 | $14.39 | $15.77 | **$18.39** |
| cached input | $1.05 | $1.05 | $0.77 | **$0.90** |
| output | $17.75 | $5.70 | $7.11 | **$6.24** |
| **total** | **$25.31** | **$21.14** | **$23.65** | **$25.52** |

**The whole of the increase is uncached input, and output actually fell.** Output
tokens are down 12.3 % on `r96repl` and the output bill with them (−$0.87); the
bill still rises $1.87 because uncached input rises $2.62. Two facts produce it,
and neither is a checkpoint:

- **Input tokens rose 16.6 % on 32 more frames.** 271 → 303 model calls at a
  growing prompt prefix. The checkpoint shape trades in the other direction from
  `r96repl`'s guarded-completion shape: calls per frame fall from 3.11 to 2.85,
  frames rise, and each new frame re-sends a prefix.
- **The cache rate did not recover.** 32.8 % against `r96repl`'s 32.9 % — flat, at
  the bottom of the range this arm has occupied since it was introduced (62 % in
  filing, 42 %, 33 %, 33 %). **$18.39 of the lane's $25.52 is uncached input**, and
  it is now the largest single line on the bill by a factor of three.

The previous report named the cache rate as the arm's biggest remaining lever.
Another draw has passed and it has not moved. Nothing in the checkpoint change
addressed it, and nothing in the checkpoint change should have been expected to.

## The print channel

| | r95repl | r96repl | **r97** |
| --- | ---: | ---: | ---: |
| frames that printed | 324 of 357 | 256 of 268 | **292 of 303** |
| frames that printed nothing | 33 | 12 | **11** |
| frames whose buffer the harness cut | 197 (55 %) | 76 (28 %) | **78 (26.7 %)** |
| total bytes printed | 1,243,043 | 2,152,646 | **2,319,522** |
| total lines printed | 18,629 | 25,775 | **29,614** |
| bytes per printing frame | 3,837 | 8,409 | **7,944** |
| **re-print frames (raw / scored)** | 71 / 71 | 75 / 74 | **103 / 98** |
| as a share of printing frames | 21.9 % | 29.3 % | **35.3 %** |
| as a share of all frames | 19.8 % | 27.7 % | **34.0 %** |

**The re-print rate rose for the third draw running: 22 % → 29 % → 35 %.** A
re-print is a frame whose buffer repeats, verbatim, a trimmed non-blank line of
20 characters or more that the *immediately preceding* frame's buffer already
delivered to it — bytes the next turn already has, paid for again in output
tokens. It was flagged as the cheapest remaining output-token saving after
`r96repl` and it has got worse, not better, while the frame count grew.

Against the call side, which stayed perfect: `repeats.information` is **0** in
`r97`, as in both earlier realm lanes. The realm has never re-read a file it was
already handed. The waste is entirely in what cells choose to print.

## Carry, filing, and the realm's own facts

| | r94 (filing) | r95repl | r96repl | **r97** |
| --- | ---: | ---: | ---: | ---: |
| frames that carried a name from an earlier cell | 3 of 333 | 192 of 357 | 100 of 270 | **145 of 303 (47.9 %)** |
| carried references | 4 | 342 | 256 | **333** |
| furthest carry | 14 frames | 12 | 8 | **9** |
| runs that carried at all | 3 | 44 | 40 | **44 of 45** |
| rebindings | 337 | 4 | 2 | **0** |
| continuing frames that filed `state` | 278 | 0 | 0 | **0** |
| continuing frames that projected `context` | 278 | 0 | 0 | **0** |
| `ReferenceError` — the realm failing to hold a name | 0 | 1 | 0 | **0** |
| cells that raised at all | — | — | — | **4** (ordinary `TypeError`s in model-written code) |

Filing is zero on both fields across 45 runs and 303 frames, which is now
structural rather than behavioural: the fields exist on the transition schema for
decoding the r90–r96 journals and nothing writes them. Carry recovered from
`r96repl`'s dip — 145 frames against 100 — because there are more frames to carry
into, and 44 of 45 runs carry at least one name. **Zero rebindings and zero
`ReferenceError`s**: nothing shadowed a name it inherited and nothing named a name
the realm was not holding.

## flows against codex, sealed, at matched high effort

`node compare-arms.mjs --manifest fullbench/rerun-r97/manifest.jsonl
--codex-manifest fullbench/codex-sealed-high-manifest.jsonl`. Both arms: the same
45 instances, the same seeded order, one attempt, 1200 s, seat
`openai:gpt-5.6-sol`, reasoning effort **high on both sides**, the same official
evaluator. 45 of 45 graded on both sides, so the four-cell table is over the full
graded intersection with nothing provisional.

| denominator | n | flows `r97` | codex `r90sh` | lead |
| --- | ---: | ---: | ---: | --- |
| raw | 45 | 36 | 38 | codex +2 |
| scored | 43 | 34 | 38 | codex +4 |
| **scored and breach-free** | **34** | **29** | **29** | **tied, zero disagreements** |

| | flows `r97` (measured) | codex `r90sh` (agent wall measured, USD derived) |
| --- | ---: | ---: |
| agent wall, raw 45 | **5,571 s** | 6,229 s |
| agent wall, scored 43 | **5,178 s** | 6,072 s |
| agent wall, breach-free 34 | **4,225 s** | 4,791 s |
| instance wall, raw 45 | 6,580 s | 6,584 s |
| USD, raw 45 | **$25.52** | $37.34 |
| USD, breach-free 34 | **$18.86** | $27.25 |

The four instances codex resolves and flows does not are
`sphinx-doc__sphinx-7590`, `django__django-12273`, `sympy__sympy-19495` and
`astropy__astropy-14369`. **All four are on the nine-run breach list in
`fullbench/reports/effort-matched-scoreboard.md` §4, and all four fetched
upstream source or the merged fix from inside the testbed container before
writing any patch.** The seal `SWB_CODEX_NETWORK=sealed` proxies the host shell;
the testbed container's own network stays up, and nine of the 45 high-effort
codex runs used it. For flows the ledger supports less: this lane's testbed
network is unrecorded, its host shell had no egress restriction, and the
evidence is a clean breach scan (0 breaches, 2 egress attempts, 0 in-container
fetches; see `airtight-scoreboard.md`), not a construction.

Restricted to the 34 scored instances codex did not breach, **the two arms
resolve the identical set: 29 each, zero flows-only, zero codex-only.** That is
the same result `r95repl` produced against the same codex lane, reproduced on a
different flows subject.

**The honest flows-vs-codex sentence: on the instances where codex did not read
the answer, flows and codex resolve exactly the same 29 of 34, and flows does it
in 12 % less of the agent's own wall clock and for 31 % less money — measured
dollars against derived ones. The superset goal is not met at the scored
denominator (0 flows-only against 4 codex-only), and every one of those four is a
run that fetched the fix.**

## Disclosures

- **Four subject files differ from HEAD and all six differing lines are
  no-ops.** See the preconditions disclosure above. The wave was pinned with
  `SWB_ALLOW_DIRTY_SUBJECT=1`, the fingerprint records every differing path, and
  the subject did not move during the wave.
- **No `wait` call anywhere in the lane**, so nothing here tests the wake fix.
  Stated as a finding rather than buried; see "The wake fix" above.
- **Zero `ctx.checkpoint()` calls**, so the mint path, its eight-per-run cap and
  all four checkpoint refusal codes are untested by this wave. Only `ctx.base` was
  exercised.
- **No budget gate reached and no disk gate blocked**: no `note` row of any kind
  in the ledger, no wait line in the driver log. $25.52 spent against a $60 gate.
- **No model retries and no provider refusals.** No `ModelError`, no flagged
  prompt, no empty patch: 45 of 45 patches non-empty, 394 B to 12,629 B.
  `r96repl` lost `django__django-13346` outright to a flagged prompt and
  `r95repl` hit the same refusal once on `sympy__sympy-19495`, which had already
  written its patch and still graded resolved. `r97` hit it zero times.
- **Four cells raised**, all ordinary `TypeError`s in model-written JavaScript
  (`django__django-16612`, `django__django-16662`, `pydata__xarray-7229`,
  `sphinx-doc__sphinx-8721`). All four runs recovered in the realm and completed.
  No `ReferenceError` in the lane.
- **No instance reached the 1,200 s budget**; `exitStatus` is 0 for all 45 and
  `timedOut` is false for all 45. The longest agent span is `sympy__sympy-13878`
  at 455 s and the longest whole instance is the same run at 461 s.
- **The two `psf/requests` rows are excluded for both arms**, as in every earlier
  column, and both were run and graded here: they keep their per-instance rows and
  are in no movement set.
- **Codex's dollars are derived and flows' are measured.** The asymmetry is the
  one `fullbench/reports/effort-matched-scoreboard.md` §1 documents: codex's CLI
  publishes one undifferentiated `tokens used` figure and no dollars, so its USD
  comes from `fullbench/codex-sealed-high/cost-derivation.md`. The agent wall
  clock on both sides is measured.
- **`./verify.sh` exits 0** at this subject across 34 sections, so every reader
  quoted here — `lib/repl-evidence.mjs`, `n-way.mjs`, `compare-runs.mjs`,
  `compare-arms.mjs`, `lib/excluded.mjs` — is pinned against its synthesised
  fixture.
- **Two counts in this report come from a reader outside the rig.** Checkpoint
  use and self-reverts are not metrics `lib/repl-evidence.mjs` has, because it
  predates both features. They were read from the same journals, the same way,
  with a companion script; it reproduces every published `r96repl` figure
  (271/258 frames, 834/803 calls, 82 completions, 81 guarded, 43 of 44 finishing
  guarded, 11/10 call-free final frames, 7 edit repeats across 4 instances) before
  it was trusted for a new one. Folding those two metrics into
  `lib/repl-evidence.mjs` is the obvious next rig change and is not made here,
  because changing a reader mid-report changes what every earlier column means.

## What this decides

**The architecture is finished and the three keys did not move for it.** That is
the whole result, and both halves of it are load-bearing.

- **Checkpoints did exactly what they were built to do, and only that.** 44 of 45
  runs adopted `ctx.base` in the first wave it existed; the five-times-one-patch
  pathology, the four self-reverts and all seven identical-mutation repeats are
  gone at once, and the lane contains none of any kind. Nobody minted a
  checkpoint, nobody hit a refusal. The mechanism is settled.
- **Guarded completion held at 99 % and every run finished.** 93 of 94
  completions behind a check, 44 of 45 finishing completions behind one, 45 of 45
  terminal transitions — the first lane in this sequence to lose no run at all.
- **Resolved is a tie, for the fourth draw.** 34 of 43, matching `r94` and
  `r95repl` and one ahead of `r96repl` on an instance `r96repl` lost to a provider.
  Nothing in four draws says the realm resolves more or less.
- **Cost is the loss.** $24.70 scored is the dearest realm draw yet, +21 % on
  `r95repl` and level with the filing arm it replaced. It is not the checkpoints:
  output tokens fell. It is 32 more frames at a cache rate that has sat at 33 %
  for two draws.
- **Wall clock is a win that has stopped improving.** −48 % against filing and
  −67 % against the r90 baseline, but −2.9 % against `r96repl` and +0.2 % against
  `r95repl`. The realm's speed advantage is real, durable across four pairings,
  and has plateaued.

**Two numbers name the next measurement, and they are the same two the last
report named.**

1. **The cache rate, 32.8 %, unmoved for two draws.** $18.39 of $25.52 is
   uncached input. A realm lane that recovers the filing arm's 62 % cache
   behaviour is a lane that wins on cost without touching a verdict, and it is now
   the only lever on this bill that is worth a wave.
2. **The re-print rate, 35.3 %, up for a third draw.** A third of printing frames
   spend part of the budget re-printing bytes the previous frame already
   delivered. Unlike the cache rate this is a teaching change, not an
   infrastructure one, and it has never been attempted.

Neither is a reason to change the model authoring surface, which stays plain
JavaScript over `await ctx.call(name, input)` under the 2026-08-20 ruling.

---

Artifacts: `fullbench/rerun-r97/` (ledger, 45 journals, 45 patches, 45 timings,
logs), `fullbench/rerun-r97/compare.md` and `compare.json` (against the r90
baseline), `logs/run_evaluation/rerun-r97/` (the evaluator's own per-instance
reports). `node n-way.mjs --wave r94=… --wave r95repl=… --wave r96repl=… --wave
r97=…` regenerates every column above from the ledgers alone.
