# The deciding paired draw: the realm after the round-2 review (r96repl vs r96)

Measured 2026-08-24 01:49Z to 06:25Z. Two lanes over the same 45 instances, same
seeded draw order, one pinned subject, one variable: `FLOWS_CELL_MODE`. `r96repl`
armed `repl` and ran first; `r96` armed `filing` and is the contemporaneous
control. Both are at the post-review subject —
`sha256:39883806c0ccf3b74a664a17b44f834de60ae8f28703e6d0cfe67a0b57d28fc6`, HEAD
`323970d67` — which is the first subject to carry the three round-2 REPL changes:
completion behind a check, a write that is visible as a write, and a print
channel whose statements share the frame budget.

**The REPL arm does not win this draw.** Against the contemporaneous filing
control it is **−1 verdict, +10 % on money, and −41 % on the agent's own wall
clock**. Against its own previous draw (`r95repl`) it is −1 verdict, +13 % on
money and +3 % on wall clock: the round-2 changes moved none of the three keys
in the arm's favour. The standing bar — cheaper **and** faster at same-or-more
resolved — is met on speed alone, which is not the bar.

**The change they were made for did land, completely.** The see-then-attest
shape is gone. 43 of 44 completing runs finish behind a check, against 11 of 44
in `r95repl`; the call-free attestation frame falls from **33 runs to 11**; and
across the whole lane exactly **one** cell wrote an unguarded `ctx.done`, against
35. The single instance that re-applied one patch five times is fixed. What did
not follow was the money: the arm buys the guard by doing more per frame, and it
pays for it in output tokens and in a print channel that now delivers 73 % more
bytes.

**The filing control had its best draw yet.** 34/43 at $20.91 and 9,064 s, which
ties r94's verdicts at −$4.05 and −917 s. The arm the REPL surface has to beat
moved while the REPL surface was being fixed.

## What moved between the two arms, and what moved since r95repl

`FLOWS_CELL_MODE` is the one variable the two lanes of *this* draw move. Both
lanes ran the same 45 instances in the same seeded order, at the same seat, on
the same budgets, from the same pinned subject, with byte-identical discipline
knobs.

| | `filing` (r96) | `repl` (r96repl) |
| --- | --- | --- |
| rendered `cell-contract` | `sha256:25a1c933ad18e979fe4282848edee5987b61783f939ac72ff45fee2b6655e8c5` | `sha256:7272668fa108fd06549308cbaab435c13debcee0f544d5ba583108a7809ec0a4` |
| characters | 9,193 | 8,312 (−881, −10 %) |
| memory between frames | `state`, a JSON document | the realm's bindings |
| channel to the next turn | `context`, `render`, `recall` | `console.log` |
| how a run ends | `{ intent: "complete", … }` | `ctx.done(output)`, taking effect where it is called |

Both digests are pinned by `packages/harness/test/CellPrompt.test.ts`, which is
green at this subject. The filing text is **byte-identical to r92's, r94's and
r95's** — 9,193 characters, same digest — so the control is a re-run of a
configuration measured three times before and not a new arm wearing its name.

Against `r95repl`, three things moved at once, all of them inside the REPL arm:

- **the contract**, 7,711 → 8,312 characters, rewriting the completion rule from
  see-then-attest to the guarded shape;
- **`ctx.done`/`ctx.park` semantics**, which now record the transition at the
  line that called them and seal the cell rather than waiting for the script to
  end;
- **the print channel**, whose statements now share one 16,384-byte frame budget
  and are elided from the middle, replacing an independent 4 KiB head cap per
  statement.

`r96repl` versus `r95repl` is therefore a three-change comparison, not a clean
one. `r96repl` versus `r96` is the clean paired A/B, and it is the one the
decision rests on.

**The model authoring surface is still plain JavaScript over `await
ctx.call(name, input)`.** The 2026-08-20 ruling stands and this draw does not
test it. Neither arm has a review step, an audit step, or anything that knows
this is SWE-bench.

## Preconditions

| | |
| --- | --- |
| subject stamp | `sha256:39883806c0ccf3b74a664a17b44f834de60ae8f28703e6d0cfe67a0b57d28fc6` |
| git HEAD at the pin | `323970d673ec08dce165f224120598c738c61ccb` |
| HEAD subject | 🔧 fix(harness): keep every short print a frame can afford, and cut between characters |
| `packages/harness` marker | `CellTurn.ts` `sha256:eb3f5ea42a5c6f70caf8bc9ca27adbbcca143c6cd018dd8ffc0482b83bc24d06` |
| `@smthrs/cli` dist | `sha256:f5dff97f3315430413ebe846783ece52e860625a01eb9f397953ffa566cd3445` (11 modules) |
| preflight refusals | none |
| node | v24.18.0 darwin-arm64 |
| seat | `openai:gpt-5.6-sol`, both lanes |
| reasoning effort | high, both lanes |
| attempts | one per instance, both lanes |
| per-instance budget | 1200 s, both lanes |
| in flight | 3, both lanes |
| disk gate | 8192 MiB, both lanes |
| budget gate | $60, both lanes |
| discipline | `readOnlyCap 12`, `maxFrames 100`, `repeatCap 4`, `narrowingCap 1`, `unmovedCap 1`, `unresolvedCap 1`, `calls 64`, `memoryBytes 268435456`, `steps 5e7`, `timeMs 30000`, `callMs 120000`, `totalMs 900000` — identical in every run of both lanes |
| population | the 45 the r90 baseline ledger graded, same seeded draw order, derived by `lib/rerun-queue.mjs` |
| grading | official evaluator, x86_64 images, run ids `rerun-r96repl` and `rerun-r96` |
| arm, as journaled | `cellMode: "repl"` in `rerun-r96repl`'s header and in every run's `discipline-armed`; `cellMode: "filing"` in `rerun-r96`'s |
| ledger completeness | 45 of 45 `graded` then `cleaned` in both lanes; no `note` row, no `journals-crashed/`, no re-run instance |

Both denominators are printed on every rate. `lib/excluded.mjs` names two
instances — `psf__requests-1766` and `psf__requests-2317` — whose verdicts are
statements about the grading environment rather than about a harness. They are
excluded for **both arms** and for every earlier column, they keep their
per-instance rows, and they are in no movement set.

Cost is every attempt, which is what the invoice says. The wall clock compared
is `agentSeconds` — the journal's own span across the agent's frames, summed per
instance. `wallSeconds`, the whole-instance figure, is reported beside it and is
not the arm's number; see the disclosure on the two killed teardowns.

## The three keys

`node n-way.mjs --wave r94=… --wave r95=… --wave r95repl=… --wave r96=… --wave
r96repl=…`. Both denominators on every row.

| | r94 (filing) | r95 (filing) | r95repl (REPL) | **r96 (filing control)** | **r96repl (REPL)** |
| --- | ---: | ---: | ---: | ---: | ---: |
| **resolved (scored, 43)** | 34 | 31 | 34 | **34** | **33** |
| resolved (raw, 45) | 36 | 33 | 36 | 36 | 35 |
| **cost (scored)** | $24.96 | $24.98 | $20.37 | **$20.91** | **$22.98** |
| cost (raw) | $25.31 | $26.61 | $21.14 | $21.22 | $23.65 |
| **agent wall (scored)** | 9,981 s | 14,232 s | 5,168 s | **9,064 s** | **5,331 s** |
| agent wall (raw) | 10,098 s | 15,325 s | 5,434 s | 9,281 s | 5,554 s |
| instance wall (scored) | 11,120 s | 15,618 s | 5,914 s | 10,047 s | 14,134 s |
| frames (scored) | 327 | 323 | 340 | 283 | 258 |
| frames (raw) | 333 | 342 | 358 | 288 | 271 |
| calls (scored) | — | 980 | 761 | 880 | 803 |
| calls per frame (scored) | — | 3.03 | 2.24 | 3.11 | 3.11 |
| wave wall clock, 3 in flight | 110 min | 149 min | 97 min | 109 min | 166 min |

### The paired A/B, r96repl against r96

| | scored (43) | raw (45) |
| --- | ---: | ---: |
| resolved | **33 − 34 = −1** | **35 − 36 = −1** |
| cost | **$22.98 − $20.91 = +$2.07 (+9.9 %)** | $23.65 − $21.22 = +$2.43 (+11.5 %) |
| agent wall | **5,331 s − 9,064 s = −3,733 s (−41.2 %)** | 5,554 s − 9,281 s = −3,727 s (−40.2 %) |

Per instance against the control: **31 of 43 faster**, 12 slower; 15 cheaper, 28
dearer; 16 with fewer frames, 27 with more.

### The REPL arm against its own previous draw

| | scored (43) | raw (45) |
| --- | ---: | ---: |
| resolved | 33 − 34 = **−1** | 35 − 36 = **−1** |
| cost | $22.98 − $20.37 = **+$2.61 (+12.8 %)** | $23.65 − $21.14 = +$2.51 (+11.9 %) |
| agent wall | 5,331 s − 5,168 s = **+163 s (+3.2 %)** | 5,554 s − 5,434 s = +120 s (+2.2 %) |

Per instance against `r95repl`: 25 faster, 18 slower; 17 cheaper, 26 dearer; 31
with fewer frames, 12 with more. **Fewer, fatter, dearer frames** is the whole
shape of the change: 258 scored frames against 340, at 3.11 calls per frame
against 2.24.

### Read the noise before reading the verdict line

r94 and r95 are two draws of one filing configuration at one digest, and they
differ by **three verdicts** (34 → 31), 43 % of agent wall and $1.30 raw. The
REPL arm's −1 against `r96` and −1 against `r95repl` are inside that spread and
inside it by a wide margin. **Resolved is a tie.** Nothing in this draw says the
realm resolves less; it says it does not resolve more, on a third pairing.

Cost is not inside the spread in the same way. The two filing draws before this
one agreed to within 5 % raw, and the REPL arm's swing is from −18 % (r95repl vs
r95) to **+10 %** (r96repl vs r96) — a 28-point reversal on a metric whose
draw-to-draw noise is roughly 5 points. The reversal is real, and section "Where
the money went" says where it came from.

Wall clock is the arm's one durable result: **−41 % against the control, on a
control that itself got 36 % faster** since r95. Three pairings now agree that
the realm is much faster than the surface that files.

### Where the money went

Same price table, `openai:gpt-5.6-sol` at $5.00/M uncached input, $0.50/M cached
input, $30.00/M output. Raw, all 45:

| | r95repl | **r96repl** | r95 | **r96** |
| --- | ---: | ---: | ---: | ---: |
| input tokens (total) | 4,984,761 | 4,696,486 | 3,427,962 | 2,836,225 |
| of which cached | 2,107,406 | 1,543,134 | 2,130,363 | 1,741,086 |
| cache rate | 42.3 % | **32.9 %** | 62.1 % | 61.4 % |
| output tokens | 190,079 | **237,142** | 635,103 | 495,761 |
| reasoning tokens | 92,177 | 108,505 | 404,615 | 297,811 |
| uncached input | $14.39 | **$15.77** | $6.49 | $5.48 |
| cached input | $1.05 | $0.77 | $1.07 | $0.87 |
| output | $5.70 | **$7.11** | $19.05 | $14.87 |
| **total** | **$21.14** | **$23.65** | **$26.61** | **$21.22** |

The REPL arm's extra $2.51 raw over `r95repl` is +$1.38 of uncached input and
+$1.41 of output, against −$0.28 of cached input. Two mechanisms, both traceable:

- **Output rose 25 % on 24 % fewer frames.** A guarded completion means the cell
  that reproduces, edits, re-checks and finishes is one cell, so cells are longer
  and there are fewer of them. Output per frame goes from 531 tokens to 875.
- **The cache rate fell 9.4 points, 42.3 % to 32.9 %.** Fewer turns mean the
  growing prompt prefix is re-sent fewer times, so a smaller share of input lands
  on a cache hit. The arm has been moving in this direction since it was
  introduced — 62 % in filing, 42 % in the first REPL draw, 33 % now — and it is
  the single largest lever left on this arm's bill.

The filing control moved the other way: its output bill fell 22 % ($19.05 →
$14.87) at an unchanged cache rate, which is where its own $5.39 raw saving came
from.

## Guarded-done adoption

The round-2 completion change exists because `sympy__sympy-13878` in `r95repl`
wrote a correct guard in frame 12, watched it decline because the suite exited 1,
and in frame 13 called `ctx.done` unguarded claiming that suite "exited 0". The
question this draw settles is whether the rewritten rule replaced that shape.

Read off the journals by `lib/repl-evidence.mjs`. A completion is **guarded**
when `ctx.done` or `ctx.park` sits behind an `if` test, inside a block an `if` or
an `else` opens, or after a `&&` or a `?` — read by walking back through balanced
parentheses and braces of literal-masked source, so a `{` in a heredoc and an
`if` in a comment are not structure. The reading can miss a real guard and cannot
invent one. `finished` names the transition that actually ended the run, so the
"finishing" rows are about the completion that took rather than every one a cell
wrote.

| | r95repl | **r96repl** | r95 (filing) | r96 (filing) |
| --- | ---: | ---: | ---: | ---: |
| runs that reached a terminal transition | 44 of 45 | 44 of 45 | 43 of 45 | 44 of 45 |
| **the finishing completion was behind a check** | **11** | **43** | n/a | n/a |
| the finishing frame had issued calls | 12 | 34 | n/a | n/a |
| **call-free final frames (see-then-attest)** | **33 of 45** | **11 of 45** | 6 of 45 | 5 of 45 |
| call-free final frames, scored (43) | 31 | 10 | 6 | 5 |
| cells that wrote a completion at all | 57 | 82 | n/a | n/a |
| of those, guarded | 22 (39 %) | **81 (99 %)** | n/a | n/a |
| of those, unguarded | 35 | **1** | n/a | n/a |

**The adoption is essentially total.** One cell in the whole lane —
`django__django-12741` — wrote a bare `ctx.done`. Every other completion in 45
runs is behind a test. The finishing completion is guarded in 43 of the 44 runs
that finished, against 11 of 44 before.

**The attestation frame did not vanish, it shrank by two thirds.** 11 runs still
end in a frame that issues no call: `astropy__astropy-14369`,
`django__django-10914`, `django__django-12741`, `django__django-13128`,
`django__django-13346`, `psf__requests-1766`, `pydata__xarray-7229`,
`sphinx-doc__sphinx-8721`, `sympy__sympy-13878`, `sympy__sympy-16450`,
`sympy__sympy-18763`. Nine of those eleven still finish behind a guard — the
model wrote the check against a value an earlier frame had bound and printed,
which is the realm working rather than the old shape surviving. The filing arm's
5 and 6 are the floor this metric sits on: a filing cell has no `ctx.done` to
read, and a last frame that called nothing is the same fact on either surface,
which is why the count is defined identically for both.

The mechanism cost is legible one row up in the three keys: calls per frame rose
from 2.24 to 3.11, exactly matching the filing arm's 3.11. A realm that finishes
in the frame that checked is a realm doing as much work per frame as a filing
cell does — which is the point, and is also why the frames got dearer.

## Edit-amnesia recurrence

An **identical-mutation repeat** is one `edit`/`write`/`apply_patch` signature —
the canonical rendering of the flow name and its input — settled in two or more
*different* frames of one run. Re-issuing inside a single frame is never a
repeat. Both arms are read by the same code.

| | r94 | r95 | r95repl | **r96repl** | r96 |
| --- | ---: | ---: | ---: | ---: | ---: |
| instances with any identical-mutation repeat | 1 | 0 | 2 | **4** | 0 |
| repeated signatures | 1 | 0 | 2 | **7** | 0 |
| repeat calls (issues beyond the first) | 1 | 0 | **5** | **7** | 0 |
| worst single instance | 1 | — | **4** | 4 | — |

Per instance, `r95repl` against `r96repl`:

| lane | instance | shape |
| --- | --- | --- |
| r95repl | `sympy__sympy-13878` | one 4,965-byte `apply_patch` issued in frames 6, 7, 8, 9 and 10 — **the same patch five times** |
| r95repl | `sphinx-doc__sphinx-11445` | one `edit` in frames 2 and 4 |
| **r96repl** | `django__django-14351` | four distinct `edit` hunks, each issued once in frame 6 and once in frame 7 — the whole edit set re-applied one time |
| **r96repl** | `django__django-13406` | one `edit` in frames 2 and 4 |
| **r96repl** | `django__django-15380` | one `edit` in frames 4 and 5 |
| **r96repl** | `sympy__sympy-13372` | one `edit` in frames 1 and 2 |

**The pathology the change was aimed at is gone.** `sympy__sympy-13878` re-applies
nothing in `r96repl`: it runs 8 frames instead of 13, finishes behind a guard,
costs $1.06 against $1.20 and resolves. Nothing in either lane repeats a mutation
more than twice, where `r95repl` had one run repeat one patch five times.

**The incidence went the other way.** Four instances instead of two, seven repeat
calls instead of five. Every one of them is a single re-issue in the very next
frame or one after — the cheap kind — and three of the four are one hunk. Read
together: the write-marking ledger removed the runaway and did not remove the
single retry. Whether the single retry is a defect at all is not settled here;
re-applying is sometimes right, and the ledger marks it rather than gating it.

Both filing lanes score zero, which is what a surface with no persistent
binding and a re-projected `state` should score, and is the control that says
this metric is about the realm.

## The print channel

`console.log` is the whole of the REPL context channel, and
`control.agent.cell-printed` journals the buffer as the next turn will read it.
The round-2 change made a frame's print statements share one 16,384-byte budget,
elided from the middle, instead of capping each statement at 4 KiB from the head.

| | r95repl | **r96repl** |
| --- | ---: | ---: |
| frames that printed | 324 of 357 | 256 of 268 |
| frames that printed nothing | 33 | 12 |
| **frames whose buffer the harness cut** | **197 (55 %)** | **76 (28 %)** |
| total bytes printed | 1,243,043 | **2,152,646 (+73 %)** |
| total lines printed | 18,629 | 25,775 |
| median buffer | 4,176 B | **6,353 B** |
| p90 buffer | 4,591 B | **16,383 B** |
| largest buffer | **16,514 B** | **16,384 B** |
| frames at or above 16,000 B | 6 | 75 |

**The old channel's binding constraint was the per-statement cap, not the frame
bound.** A median of 4,176 bytes and a p90 of 4,591 against a 16,384-byte frame
budget is a channel losing statements with the budget unspent, which is exactly
what the change said it was. After it, p90 sits one byte under the budget and 75
frames of 268 sit exactly on it: **the frame budget is now the constraint, and it
is saturated in 28 % of frames.** The bound is also tighter than what it replaced,
by construction and in the measurement: the largest buffer any frame delivered is
16,384 bytes exactly, against 16,514 before.

### Re-print frames

A **re-print** is a frame whose buffer repeats, verbatim, at least one trimmed
non-blank line of 20 characters or more that the *immediately preceding* frame's
buffer already delivered to it. That buffer is exactly what this turn was handed,
so repeating it spends output tokens on bytes already in the context — the print
channel's own version of the note-taking failure `repeats.information` counts for
calls. The count is flat across the whole threshold band 16–36 on `r95repl` (72
down to 66), so nothing turns on the exact number; the previously measured
bracket of **67–74** is reproduced at **71**.

| | r95repl | **r96repl** |
| --- | ---: | ---: |
| re-print frames (raw) | **71** | **75** |
| re-print frames (scored, 43) | 71 | 74 |
| as a share of printing frames | 21.9 % | **29.3 %** |
| as a share of all frames | 19.8 % | **27.7 %** |

**Absolutely flat, relatively worse.** Four more re-print frames out of 87 fewer
frames is a rate that rose by 7.4 points. The channel now delivers what a frame
asked it to, and the model spends part of that larger allowance re-printing what
it was just handed. This is the one adopted change that made a measured behaviour
worse, and it is the obvious place for the next one: the budget is spent, and
28 % of the frames that spend it spend some of it on bytes the next turn already
has.

For contrast, the call-side note-taking failure stayed at zero. Neither REPL lane
re-read a file it had already been handed, in any frame, in any run —
`repeats.information` is 0 in `r95repl` and 0 in `r96repl`, against 8 in `r95` and
2 in `r96`. The realm is still doing the thing it was built to do; the print
channel is where it is now wasteful.

### Carry, filing, and the realm's own facts

| | r95repl | **r96repl** | r95 | r96 |
| --- | ---: | ---: | ---: | ---: |
| frames that carried a name from an earlier cell | 192 of 357 (54 %) | 100 of 270 (37 %) | 3 of 340 | 2 of 288 |
| carried references | 342 | 256 | 3 | 3 |
| furthest carry | 12 frames | 8 frames | — | — |
| runs that carried at all | 44 of 45 | 40 of 45 | — | — |
| rebindings | 4 | 2 | 351 | 251 |
| continuing frames that filed `state` | **0** | **0** | 285 | 230 |
| continuing frames that projected `context` | **0** | **0** | 285 | 230 |
| `ReferenceError` — the realm failing to hold a name | 1 | **0** | 0 | 0 |

Filing stayed at zero on both fields across 45 runs and 271 frames: nothing was
filed and no context was hand-projected, with no fallback to the old surface
anywhere in the lane. Carry fell, in frames and in depth, and that is the guarded
completion doing its job rather than the realm being abandoned — a run that
finishes in the frame that checked has fewer later frames to carry into. 40 of 45
runs still carry, and the arm still rebinds two names where the filing arm
rebinds 251.

## Per-instance agreement

43 scored pairs. **The two arms agree on 38 and disagree on 5.**

| | instances |
| --- | --- |
| both resolved | 31 |
| both unresolved | 7 — `astropy__astropy-14365`, `django__django-12273`, `django__django-13212`, `pydata__xarray-7229`, `sphinx-doc__sphinx-7590`, `sympy__sympy-18763`, `sympy__sympy-19495` |
| **REPL only** | 2 — `django__django-15987`, `sympy__sympy-13878` |
| **filing only** | 3 — `astropy__astropy-14369`, `django__django-13346`, `django__django-15732` |

One of the three filing-only wins is not a contest. `django__django-13346` in the
REPL lane produced an **empty patch** because the provider refused the prompt:
the run died on `flows/model/ModelError: Invalid prompt: your prompt was flagged
as potentially violating our usage policy`. `r95repl` lost exactly one run the
same way — `sympy__sympy-19495`, which had already written its patch and still
graded resolved. Both REPL lanes hit this once in 45; neither filing lane hit it
at all, which on two draws is not enough to call it an arm effect.

Netting that instance out leaves the arms at 33 apiece on 42 comparable
instances. **This is the third pairing in a row in which the realm's verdict count
is a tie inside the filing arm's own draw-to-draw spread.**

Against the whole five-lane sequence, taking r94 as the baseline and r96repl as
the newest wave: recovered `django__django-13128`, `django__django-14351`,
`django__django-15987`, `sphinx-doc__sphinx-7757` and `sympy__sympy-13878`; still
lost `django__django-13346` and `django__django-15732`; gained
`django__django-11815`.

The full per-instance table, verdict / cost / agent seconds / frames, for
`r95repl`, `r96repl` and `r96`, is in
`fullbench/rerun-r96repl/` and `fullbench/rerun-r96/` alongside each lane's
ledger; `node n-way.mjs --wave …` regenerates every column from the ledgers alone.

## What the draw found that nobody asked it to

**Two runs in `r96repl` never woke from a durable clock, and had to be killed.**
`psf__requests-2317` and `pytest-dev__pytest-6197` are the only two runs in any
of the five lanes that called the `wait` flow. In both, the sequence off the
journal is identical and ends there:

```
control.agent.cell-call-started   {"flowName":"wait","input":{"seconds":120,…}}
flows.engine.deferred-completed   DurableClock/harness/wait/…
flows.engine.run-decision         {"decision":"wake-scheduled","reason":"clock"}
                                  ← nothing follows
```

The clock fired, the engine decided to wake, and the run never resumed. Both
processes sat idle until they were killed together at 04:15:25Z, after 5,892 s
and 8,527 s of wall clock against agent spans of 181 s and 572 s. Neither reached
the 1,200 s budget and neither is recorded as timed out, because the budget is on
the agent's own span and the agent had stopped.

Three things follow, and the third is why this is in the report rather than only
in a bug:

1. **No verdict is affected.** Both runs had already produced their patch and
   both graded `resolved`. The lane's 35/45 and 33/43 stand.
2. **The instance-wall column for `r96repl` is not a measurement of the arm.**
   14,419 s of its 20,077 s raw instance wall is those two hung teardowns.
   Removing `pytest-dev__pytest-6197`'s 8,527 s from the scored figure leaves
   5,607 s, against `r95repl`'s 5,914 s. The `agentSeconds` column, which is what
   this benchmark compares, is untouched: it reads the journal's own frame spans.
3. **Both runs reached `wait` down the same path.** Each applied a `complete`
   transition, had it refused by `control.agent.narrow-only-demanded` — the
   discipline's `narrowingCap` demanding one narrowing turn before a run may
   finish — and then kept going. A refused completion turns the turn's outcome
   back into `continue`, and these two runs answered that by waiting on a long
   test command instead of narrowing. The refusal itself is routine: 3 runs in
   `r96repl`, 7 in `r96`, 5 in r94, and every other one of them recovered and
   completed. What is not routine is that the two that reached `wait` never came
   back.

This is a defect in the wake path, not in the REPL arm, and it is filed as an
observation rather than fixed here: fixing it would move the subject that both
lanes of this draw were measured against.

## Disclosures

- **The two lanes ran sequentially, not interleaved, and the REPL arm ran first.**
  `r96repl` spans 01:49Z to 04:35Z (166 min); `r96` started 04:35Z and ran to
  06:25Z (109 min). The reason is the one r95repl's report gives: this machine has
  16 cores and sits near load 12 with three instances in flight, and the agent's
  own frame span — the wall clock this benchmark compares — is exactly what CPU
  contention inflates.
- **`r96repl`'s 166-minute wave wall is not the arm's number.** It is dominated by
  the two hung teardowns above, which held two of the three slots for the last
  two hours of the wave. Its agent wall, 5,554 s raw, is 40 % under the control's.
- **One commit landed while `r96` was in flight, and the pinned subject did not
  move.** `1e723e01b` at 22:54 local (05:54Z) touches only
  `evals/swebench/lib/repl-evidence.mjs` and
  `evals/swebench/fixtures/check-repl-evidence.mjs` — the reader this report's
  guarded-completion and re-print counts come from. Neither file is in the subject
  and neither is loaded by the per-instance pipeline. `node lib/subject.mjs
  --check` exits 0 at the same stamp,
  `sha256:39883806c0ccf3b74a664a17b44f834de60ae8f28703e6d0cfe67a0b57d28fc6`,
  before and after it, and every `flows.sh` invocation in both lanes checked
  itself against that stamp or refused to run. The two harness commits this draw
  measures — `c23c21e4f` and `323970d67` — both landed **before** the first lane
  opened, at 17:19 and 17:46 local against `r96repl`'s 18:49 start.
- **The reader was extended between the two lanes' analyses, and reads both
  identically.** `strip`, `declared` and `referenced` are byte-for-byte unchanged
  over all 967 cells of the r94, r95, r95repl and r96repl lanes; the literal scan
  they share is now also used, blanked in place, by the structural reader that
  decides whether a completion is guarded. Every count in this report was taken
  after that change, from the same code, for every lane.
- **Model retries: two in `r96repl` across two instances** (`astropy__astropy-14365`,
  `sphinx-doc__sphinx-11445`), against six across five in `r95repl`. All
  recovered.
- **One instance reached the 1,200 s budget, in the filing control**:
  `sympy__sympy-13878` at 1,182 s of agent span across 25 frames, harness exit
  124, graded `unresolved`. No `r96repl` instance came close; its longest agent
  span was 747 s.
- **One empty patch, in the REPL lane** (`django__django-13346`, the provider
  refusal). `r96` recorded none: 45 of 45 patches.
- **Neither budget gate was reached and neither disk gate blocked**: no `note` row
  of any kind in either ledger, and no wait line in either driver log.
- **`./verify.sh` exits 0** at this subject, so every reader quoted here —
  including `lib/repl-evidence.mjs`, whose definitions this report turns on — is
  pinned against its synthesised fixture.

## What this decides

**The REPL arm is not adopted on this draw.** The standing bar is cheaper *and*
faster at same-or-more resolved. It is faster, decisively and for the third
pairing running. It is neither cheaper nor same-or-more resolved:

- **resolved: a tie, for the third time.** 33 against 34 is one verdict on a
  population whose filing control has swung three verdicts between two draws of
  one configuration. Netting out the provider refusal it is 33 apiece. Nothing
  here is evidence either way.
- **cost: a loss, and a reversal.** +10 % against the contemporaneous control and
  +13 % against the arm's own previous draw, where the previous draw was −18 %.
  The round-2 changes bought the guard with output tokens and a bigger print
  buffer, and gave back the arm's only non-speed win.
- **wall clock: a win, large.** −41 % against a control that itself got 36 %
  faster since r95. This is the arm's durable result and it has now survived three
  pairings and a control that improved underneath it.

**The three round-2 changes should be judged separately, because they did not
land together.** The completion rewrite did exactly what it was for: 99 % of
completions are behind a check, the attestation frame fell from 33 runs to 11,
and the five-times-one-patch pathology is gone. The write-marking ledger removed
the runaway repeat and left the single retry. The print-channel change fixed the
constraint it named — no more losing statements with the budget unspent, and a
tighter bound than it replaced — and in doing so raised the re-print rate from
22 % to 29 % and put roughly $1.38 of uncached input on the bill.

**Two numbers name the next measurement, and neither is the arm's surface.**

1. **The cache rate, 32.9 %.** It has fallen at every step of this arm's life
   (62 % filing → 42 % → 33 %) and it is now where the money is: $15.77 of the
   arm's $23.65 is uncached input. A REPL lane that recovers the filing arm's
   cache behaviour is a REPL lane that wins on cost without touching a verdict.
2. **The re-print rate, 29 %.** Twenty-eight per cent of frames now saturate the
   print budget and 29 % of printing frames spend part of it re-printing what the
   previous frame already delivered. That is the cheapest remaining output-token
   saving on this arm, and unlike the cache rate it is a teaching change rather
   than an infrastructure one.

Neither is a reason to change the model authoring surface, which stays plain
JavaScript over `await ctx.call(name, input)` under the 2026-08-20 ruling.
