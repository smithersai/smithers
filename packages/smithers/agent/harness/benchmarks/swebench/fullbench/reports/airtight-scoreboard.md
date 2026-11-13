# The airtight scoreboard

> **Historical report — cost comparison not independently reproducible.**
> The reported $37.38 codex versus $24.70 flows (1.51× scored) comparison
> cannot be audited from this snapshot. The derivation program, codex
> transcripts and ledger, and flows `r97` journals and ledger are absent;
> no accessible archive with hashes or deterministic replay check is linked.
> The tables retain historical reported figures. Labels such as `measured`
> and `derived` describe their original collection method, not independent
> verification from the published files.

**Read this line first: the scoreboard is one arm short of airtight, and the
missing arm is ours.** Codex ran the whole 45 inside a `--network none` testbed
and its lane is complete and valid. The flows lane that would have matched that
condition, `r98`, is **void**: the OpenAI API stopped serving model calls
mid-lane and 35 of 45 instances never ran. The flows column below is therefore
`r97` — the same subject, the same 45 instances, the same seat, measured the
previous evening without the sealed testbed.

## The headline

> **Sealed at the kernel, codex resolves 34 of 43 scored — the same 34 flows
> resolves, with nothing in either arm's exclusive column — for a historically
> reported $37.38 derived against flows' $24.70 measured (_cost comparison not
> independently reproducible_) and 5,271 s of agent wall against 5,178 s. The
> four-instance lead codex held before the testbed was sealed *was* the testbed:
> all four evaporated, and three of the four were runs the breach scan caught
> fetching the upstream fix.**

Provenance for that sentence: codex `r90n`, evaluator run `fullbench-codex-none`,
ledger `fullbench/codex-none-manifest.jsonl`, 45 of 45 containers observed
`--network none` by `docker inspect`, 0 breaches, 0 web-search lines, run
2026-08-25 07:31:50Z → 09:10:14Z. flows `r97`, ledger
`fullbench/rerun-r97/manifest.jsonl`, subject
`sha256:830a7fe3f29774f8b1f5c99471556da30769fe513efafa527ede25e331251e55` at git
HEAD `0575fca03`, run 2026-08-24 18:26:51Z → 19:47:49Z, testbed network
**unrecorded**. Both arms `gpt-5.6-sol` at reasoning effort **high**, 1,200-second
per-instance budget, one attempt per instance, graded by the official evaluator.
Costs: flows measured from journal counters, codex derived by the footer method
in `fullbench/codex-none/cost-derivation.md`. The sentence is quotable only with
both the condition asymmetry and the cost comparison's missing source evidence
named — see [What is airtight and what is not](#what-is-airtight-and-what-is-not)
and [Artifacts](#artifacts).

## What is airtight and what is not

| | codex `r90n` | flows `r97` | flows `r98` |
| --- | --- | --- | --- |
| testbed container | **`--network none`, 45 of 45 observed** | unrecorded (`bridge`-era default) | **`--network none`, 45 of 45 observed** |
| host shell egress | dead proxy `127.0.0.1:1` | none configured | none configured |
| codex `web_search` | **disabled**, 0 lines in 45 transcripts | n/a | n/a |
| breach scan | **0 breaches**, 56 egress attempts, 6 in-container fetches all shown failing | 0 breaches, 2 egress attempts (`pip install Pillow`), **0 in-container fetches** | 0 breaches, 0 egress attempts |
| instances with a real attempt | 45 of 45 | 45 of 45 | **10 of 45** |
| status | **complete and valid** | complete and valid, **wrong condition** | **VOID** |

Three separate facts, and they are worth keeping apart.

**Codex's seal is a construction, not an inspection.** A container whose only
interface is `lo` cannot fetch an upstream patch whatever command runs inside
it. Twenty-four of the 45 runs reached for the network anyway; every attempt is
shown failing in the run's own trace, and six of those were in-container fetches
that a `bridge` lane would have counted as breaches and this lane reads to their
outcome. That reading is itself new — `breach-scan.mjs` was fixed at
`da332216d` after its first pass reported six breaches it could not have had —
and it fails closed: an unrefuted fetch in a container never shown refusing
anything stays a breach.

**flows `r98`'s seal held; its model supply did not.** All 45 of its containers
were observed `none` and its breach scan is clean, so the sealed-testbed
plumbing is proven end to end for the flows arm. What failed is orthogonal: at
2026-08-25T09:23:12Z the OpenAI API began answering every call with HTTP 429
`credit_balance_exhausted`. Read off the ledger, **34 of the 45 runs made zero
model calls and spent $0**; one more (`django__django-16901`) got a single call
served for $0.0417 and then hit the wall; 10 ran to completion before it. Total
spend on the void lane: $6.41. `fullbench/rerun-r98/VOID.json` marks it so no
later reader scores it.

**flows `r97` is the wrong condition, and the direction of that error is
knowable.** An unsealed testbed can only *help* the arm that has it. Whether
`r97` took the help is an inspection question, and the inspection is clean:
`breach-scan.mjs` over its ledger, its 45 driver logs and its 45 journals — which
record every call the agent made and every result it got back — finds **zero
in-container fetches** and exactly two egress commands in the whole lane, both
`pip install Pillow` in `django__django-13343`, neither of them a reach for the
answer. Compare codex at the same point in its history: `r90sh`'s eight breached
runs fetched merged pull requests, issue threads, `main`-branch source files and
a later PyPI release. **An inspection that finds nothing is weaker evidence than
a kernel that permits nothing.** It is not nothing, and it is what stands until
`r99` runs.

## 1. The three keys, both denominators

`lib/excluded.mjs` names `psf__requests-1766` and `psf__requests-2317`, whose
verdicts are statements about which httpbin the grading container reaches rather
than about a harness. They are excluded from every rate for both arms, they keep
their per-instance rows, and both denominators are printed on every line.

Cost is every attempt, which is what the invoice says. The wall clock compared
is the agent's own: `agentSeconds` for codex, the journal's span for flows,
summed per instance and rounded per instance, exactly as `compare-runs.mjs`
folds it. Whole-instance wall — which includes the image pull, the checkout
extract and the patch capture, and which the two arms do differently — is
reported beside it and is not one of the keys.

| | flows `r97` | codex `r90n` | delta |
| --- | ---: | ---: | ---: |
| **resolved (scored, 43)** | **34** | **34** | **0** |
| resolved (raw, 45) | 36 | 36 | 0 |
| **cost (scored, 43; not independently reproducible)** | **$24.70** reported measurement | **$37.38** reported estimate | reported codex +$12.68, ×1.51 |
| cost (raw, 45; not independently reproducible) | $25.52 reported measurement | $38.73 reported estimate | reported codex +$13.21, ×1.52 |
| cost, no-cache upper bound (scored) | — | $86.25 | — |
| **agent wall (scored, 43)** | **5,178 s** | **5,271 s** | codex +93 s (+1.8 %) |
| agent wall (raw, 45) | 5,571 s | 5,415 s | codex −156 s (−2.8 %) |
| instance wall (scored, 43) | 6,151 s | 5,547 s | codex −604 s |
| instance wall (raw, 45) | 6,580 s | 5,697 s | codex −883 s |
| model calls / API requests (scored) | 290 | 699 | codex ×2.4 |
| output tokens (scored) | 202,157 measured | 891,544 derived | codex ×4.4 |
| input tokens (scored) | 5,278,811 measured, 32.7 % cached | 11,900,587 modelled, 91.3 % cached | — |
| cost per resolved (scored) | **$0.73** | $1.10 | — |
| wave wall clock | 79 min, 3 in flight | 98 min, 2 in flight | — |

**The reported resolved counts tie on the same instances.** The historical cost
ratio is 1.51× scored and 1.52× raw, with a reported model sensitivity range of
1.33×–1.70× over 22 feasible settings. Neither the cost comparison nor its
sensitivity sweep is independently reproducible from the published files.
Agent wall is a tie inside the noise — it changes sign between the
scored and raw denominators, which is what a 2 % difference on 45 single-attempt
runs looks like.

**One column is measured and one is modelled, and they are not the same kind of
number.** Every flows figure comes off the run's own journal through
`lib/run-cost.mjs`: four token counters per model call, priced by `prices.ts`.
Every codex dollar is reconstructed from 45 transcripts because `codex exec`
prints one undifferentiated `tokens used` footer and runs under `--ephemeral`.
The derivation, its calibration against two published lanes, and its 27-cell
sensitivity sweep are in `fullbench/codex-none/cost-derivation.md`. The one
codex number in this table that is measured rather than derived is the wall
clock.

### The void column, for completeness

`r98` has no rate and appears in no comparison. What it does have:

| | value |
| --- | ---: |
| instances that ran to completion | 10 of 45 |
| instances with 0 model calls served | 34 of 45 |
| instances with 1 call then the wall | 1 (`django__django-16901`) |
| verdict tally | 9 resolved, 1 unresolved, 35 `empty patch` |
| spend before the wall | $6.41 |
| containers observed `none` | 45 of 45 |
| breaches | 0 |

The 10 that ran agree with `r97` on 10 of 10 — the same verdict on every one.
**That is an agreement count on 10 instances, not a rate, and it is not evidence
about the other 35.** It is quoted here only because it is the only thing the
void lane can honestly say: where a model call was served under the sealed
testbed, flows did what it did without it.

A rig gap the void exposed and nobody has closed: the flows driver recorded a
provider refusal as `exit 0` plus `empty patch`, which is byte-indistinguishable
from "the agent tried and produced nothing". A lane that cannot get a model
served should fail loudly. That is a change to `run-45.sh`'s failure
classification, and it was correctly not made mid-benchmark.

## 2. The per-instance four-cell

**The airtight four-cell does not exist and this report does not manufacture
one.** It needs both arms under the sealed testbed, and one of them is void.
`compare-arms.mjs` was run over the flows lane that *does* have 45 real
attempts, and the table below is that: sealed codex against unsealed-testbed
flows, on one population, with the asymmetry stated in every place the numbers
appear.

`node compare-arms.mjs --manifest fullbench/rerun-r97/manifest.jsonl
--codex-manifest fullbench/codex-none-manifest.jsonl`:

| | scored (43) | raw (45) |
| --- | ---: | ---: |
| both resolved | **34** | **36** |
| **flows only** | **0** | **0** |
| **codex only** | **0** | **0** |
| neither | 9 | 9 |

**Both exclusive columns are empty.** On all 43 scored instances the two arms
agree, verdict for verdict: 34 resolved by both, 9 resolved by neither, and not
one instance where one arm succeeded and the other did not. That has never
happened on this population before — `r97` against breach-era codex `r90sh` had
a codex-only column of four.

**The standing superset goal is met on this pairing.** It asks that flows
resolve a superset of what codex resolves on the same instances; codex-only is
0, so it holds, and it holds by equality rather than by margin. It has failed on
every previous pairing of these lanes. Every one of them, folded the same way
over the same 43 scored instances:

| flows lane | codex lane | codex's condition | both | flows only | **codex only** | neither |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `r90` | `r90c` | network, medium effort | 32 | 1 | 6 | 4 |
| `r90` | `r90s` | shell sealed, medium | 32 | 1 | 4 | 6 |
| `r90` | `r90sh` | shell sealed, high | 32 | 1 | 6 | 4 |
| `r90` | `r90n` | **testbed `none`**, high | 32 | 1 | 2 | 8 |
| `r97` | `r90c` | network, medium | 33 | 1 | 5 | 4 |
| `r97` | `r90s` | shell sealed, medium | 34 | 0 | 2 | 7 |
| `r97` | `r90sh` | shell sealed, high | 34 | 0 | 4 | 5 |
| **`r97`** | **`r90n`** | **testbed `none`**, high | **34** | **0** | **0** | **9** |

The codex-only column is the goal's failure count, and it falls to zero exactly
once: when the testbed is sealed at the kernel. Note the row above it — the same
flows lane against the same codex model at the same effort, differing only in
whether the test container had a network, loses four instances to codex. **The
goal is met against a codex arm that could not cheat, and not yet against one
measured beside a flows arm that could not either.** That is the whole remaining
gap and it is one lane wide.

The nine neither-resolved: `astropy__astropy-14365`, `astropy__astropy-14369`,
`django__django-12273`, `django__django-13212`, `django__django-15732`,
`pydata__xarray-7229`, `sphinx-doc__sphinx-7590`, `sympy__sympy-18763`,
`sympy__sympy-19495`. Both-fail is a result, not a gap: four of these nine were
codex wins at `r90sh`, and three of those four were wins it fetched.

The historical per-instance table reports flows cheaper on 35 of the 43 scored
instances and dearer on 8, and faster on 24 and slower on 19. The per-instance
cost comparison shares the missing-evidence limitation of the totals; it is
not independently reproducible.

### Every instance

`fetched in r90sh` counts the in-container fetches the breach scan attributed to
that instance in the breach-era codex lane — the runs whose `r90sh` verdicts the
README already declares void. codex USD is derived, flows USD is measured.

| instance | cell | flows `r97` | codex `r90n` | codex `r90sh` | fetched in `r90sh` | flows USD (measured) | codex USD (derived) | flows agent s | codex agent s |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `astropy__astropy-7166` | both | resolved | resolved | resolved | — | $0.23 | $0.48 | 50 | 36 |
| `astropy__astropy-8707` | both | resolved | resolved | resolved | 2 | $0.95 | $0.76 | 131 | 100 |
| `django__django-10914` | both | resolved | resolved | resolved | — | $0.58 | $0.63 | 81 | 131 |
| `django__django-11299` | both | resolved | resolved | resolved | — | $1.06 | $0.71 | 451 | 64 |
| `django__django-11490` | both | resolved | resolved | resolved | — | $0.28 | $0.96 | 59 | 94 |
| `django__django-11815` | both | resolved | resolved | resolved | 5 | $0.27 | $0.78 | 72 | 100 |
| `django__django-12741` | both | resolved | resolved | resolved | — | $0.29 | $0.57 | 69 | 77 |
| `django__django-13128` | both | resolved | resolved | resolved | 3 | $0.46 | $1.04 | 96 | 179 |
| `django__django-13343` | both | resolved | resolved | resolved | — | $0.45 | $0.54 | 71 | 63 |
| `django__django-13346` | both | resolved | resolved | resolved | — | $0.73 | $0.85 | 116 | 140 |
| `django__django-13406` | both | resolved | resolved | resolved | — | $0.41 | $0.62 | 84 | 69 |
| `django__django-13821` | both | resolved | resolved | resolved | — | $0.25 | $1.27 | 64 | 91 |
| `django__django-14351` | both | resolved | resolved | resolved | — | $1.54 | $1.48 | 166 | 138 |
| `django__django-15380` | both | resolved | resolved | resolved | — | $0.48 | $0.58 | 66 | 46 |
| `django__django-15569` | both | resolved | resolved | resolved | — | $0.47 | $0.59 | 98 | 58 |
| `django__django-15987` | both | resolved | resolved | resolved | — | $0.23 | $0.67 | 64 | 78 |
| `django__django-16612` | both | resolved | resolved | resolved | — | $0.75 | $0.59 | 100 | 46 |
| `django__django-16662` | both | resolved | resolved | resolved | — | $0.27 | $0.58 | 87 | 41 |
| `django__django-16899` | both | resolved | resolved | resolved | — | $0.73 | $0.55 | 103 | 54 |
| `django__django-16901` | both | resolved | resolved | resolved | 2 | $0.33 | $0.83 | 79 | 97 |
| `matplotlib__matplotlib-20826` | both | resolved | resolved | resolved | — | $1.03 | $0.76 | 131 | 78 |
| `matplotlib__matplotlib-20859` | both | resolved | resolved | resolved | — | $0.41 | $0.69 | 77 | 75 |
| `matplotlib__matplotlib-22865` | both | resolved | resolved | resolved | — | $0.55 | $0.74 | 97 | 91 |
| `matplotlib__matplotlib-24970` | both | resolved | resolved | resolved | — | $0.42 | $0.87 | 120 | 157 |
| `psf__requests-1766` ⟂ | both | resolved | resolved | unresolved | — | $0.22 | $0.61 | 76 | 53 |
| `psf__requests-2317` ⟂ | both | resolved | resolved | unresolved | — | $0.60 | $0.74 | 317 | 91 |
| `pydata__xarray-7233` | both | resolved | resolved | resolved | — | $0.25 | $0.69 | 47 | 77 |
| `pydata__xarray-7393` | both | resolved | resolved | resolved | — | $0.36 | $0.74 | 66 | 79 |
| `pytest-dev__pytest-6197` | both | resolved | resolved | resolved | 2 | $1.15 | $1.49 | 157 | 320 |
| `sphinx-doc__sphinx-11445` | both | resolved | resolved | resolved | — | $0.54 | $1.05 | 390 | 117 |
| `sphinx-doc__sphinx-7757` | both | resolved | resolved | resolved | — | $0.41 | $0.87 | 73 | 80 |
| `sphinx-doc__sphinx-8721` | both | resolved | resolved | resolved | — | $0.73 | $0.71 | 263 | 70 |
| `sympy__sympy-13372` | both | resolved | resolved | resolved | — | $0.23 | $0.59 | 66 | 46 |
| `sympy__sympy-13878` | both | resolved | resolved | resolved | — | $1.83 | $2.29 | 455 | 550 |
| `sympy__sympy-16450` | both | resolved | resolved | resolved | — | $0.18 | $0.79 | 54 | 159 |
| `sympy__sympy-20154` | both | resolved | resolved | resolved | — | $0.28 | $0.67 | 56 | 245 |
| `astropy__astropy-14365` | neither | unresolved | unresolved | unresolved | — | $0.31 | $0.61 | 69 | 39 |
| `astropy__astropy-14369` | neither | unresolved | unresolved | resolved | 1 | $1.08 | $1.39 | 122 | 136 |
| `django__django-12273` | neither | unresolved | unresolved | resolved | — | $0.31 | $1.18 | 81 | 159 |
| `django__django-13212` | neither | unresolved | unresolved | unresolved | — | $0.73 | $0.71 | 121 | 152 |
| `django__django-15732` | neither | unresolved | unresolved | unresolved | — | $0.75 | $0.85 | 102 | 114 |
| `pydata__xarray-7229` | neither | unresolved | unresolved | unresolved | — | $0.94 | $1.25 | 261 | 168 |
| `sphinx-doc__sphinx-7590` | neither | unresolved | unresolved | resolved | 5 | $0.99 | $1.63 | 149 | 370 |
| `sympy__sympy-18763` | neither | unresolved | unresolved | unresolved | — | $0.19 | $0.76 | 48 | 61 |
| `sympy__sympy-19495` | neither | unresolved | unresolved | resolved | 2 | $0.31 | $0.97 | 66 | 226 |

## 3. What the sealed testbed actually changed, per arm

### codex: `r90sh` → `r90n`

One variable moved. Same 45 instances, same model, same `high` effort, same
1,200-second budget, same dead host proxy, same disabled web search, same
grading rig; `SWB_TESTBED_NETWORK=none`.

| | `r90sh` (testbed `bridge`) | `r90n` (testbed `none`) | delta |
| --- | ---: | ---: | ---: |
| **resolved (scored, 43)** | 38 | **34** | **−4** |
| resolved (raw, 45) | 38 | 36 | −2 |
| cost (scored, derived, same implementation; not independently reproducible) | $35.81 | $37.38 | +$1.57 (+4.4 %) |
| cost (raw, derived; not independently reproducible) | $37.24 | $38.73 | +$1.49 (+4.0 %) |
| agent wall (scored) | 6,072 s | 5,271 s | **−801 s (−13.2 %)** |
| agent wall (raw) | 6,229 s | 5,415 s | −814 s (−13.1 %) |
| API requests | 729 | 728 | −1 |
| footer tokens | 1,982,783 | 2,008,260 | +1.3 % |
| in-container fetches that succeeded | **22, across 8 runs** | **0, by construction** | — |

**Four scored instances moved out of codex's column and none moved in.**

| instance | `r90sh` | `r90n` | fetched upstream in `r90sh` |
| --- | --- | --- | --- |
| `sphinx-doc__sphinx-7590` | resolved | **unresolved** | yes — `pip download Sphinx`, a later release (5 fetches) |
| `sympy__sympy-19495` | resolved | **unresolved** | yes — `api.github.com/…/issues/19495` (2 fetches) |
| `astropy__astropy-14369` | resolved | **unresolved** | yes — `raw.githubusercontent.com/…/main/…/format/cds.py` (1 fetch) |
| `django__django-12273` | resolved | **unresolved** | no |

The two instances that moved the other way, `psf__requests-1766` and
`psf__requests-2317`, are the pair `lib/excluded.mjs` keeps out of every rate for
both arms; that is why raw moves by 2 where scored moves by 4. Their verdicts
turn on which httpbin the grading container reaches, which is exactly the kind of
thing a network condition changes, and exactly why they are excluded.

**Split the population by whether codex breached it and the effect separates
cleanly.** Of the 43 scored instances, 8 are ones `r90sh`'s breach scan caught
fetching upstream hindsight and 35 are not:

| | breach-free 35 | breached 8 | all 43 |
| --- | ---: | ---: | ---: |
| codex `r90sh` resolved | 30 | 8 | 38 |
| codex `r90n` resolved | **29** | **5** | **34** |
| delta | **−1** | **−3** | −4 |
| flows `r97` resolved | 29 | 5 | 34 |

**Sealing the testbed cost codex one verdict among the instances it was not
fetching on, and three among the eight it was.** Five of the eight breached runs
resolve anyway without the network, so five of those fetches were not what
carried them. Three were.

**The four losses are real losses, not a starved test environment.** This is the
one way `--network none` could produce a false negative — a graded test that
needs the internet — and the evaluator's own reports rule it out on all four:
every patch applied cleanly, `PASS_TO_PASS` came back clean (24/24, 27/27, 8/8,
and 731 of 732 on `astropy__astropy-14369`, whose single miss is a sibling
parametrisation of the `FAIL_TO_PASS` test itself), and every one failed on
`FAIL_TO_PASS`. These are patches that did not fix the issue.

The residual risk on that claim is coverage, not logic: `./preflight-network.sh`
probed 3 instances under both network conditions and got identical outcomes
(`django__django-16612` exit 1 both, `sympy__sympy-20154` exceeded 900 s both,
`astropy__astropy-14365` exit 2 both). Not probed: matplotlib (4), pydata (3),
pytest-dev (1), sphinx-doc (4). `sphinx-doc__sphinx-7590` is in an unprobed
family — its per-instance evaluator report is what rules it out, not the
preflight. Widen with `SWB_PREFLIGHT_INSTANCES` if this matters more than wall
clock.

### flows: `r97` → `r98`

| | value |
| --- | --- |
| what the sealed testbed changed for flows | **unmeasured** |
| why | `r98` is void: 35 of 45 instances never got a model call served |
| what is known instead | `r97`'s traces show 0 in-container fetches and 2 host egress commands in 45 runs, both `pip install Pillow` |
| the expected effect, therefore | zero — an agent that never reached for the network loses nothing when the network is taken away |
| the status of that expectation | **a prediction, not a measurement** |

This is the asymmetry that keeps the scoreboard from being airtight, and it
should not be dressed up. For codex the sealed testbed was worth −4 scored
verdicts, and it was worth that because eight of its runs were using the hole.
For flows the same change is expected to be worth 0, because no run is recorded
using the hole — but "no run is recorded using it" is a statement about what a
scan of 45 driver logs and 45 journals found, and codex's own `r90sh` seal was
also believed until a scan of its transcripts found eight breaches in it. **A
prediction that an arm will not lose anything is exactly the prediction a
benchmark is supposed to test rather than assume.**

The single-variable control for that test is already in place: `./preflight.sh`
re-pinned the subject for `r98` at stamp
`sha256:830a7fe3f29774f8b1f5c99471556da30769fe513efafa527ede25e331251e55`,
byte-identical to `r97`'s, so a re-run differs from `r97` in
`SWB_TESTBED_NETWORK=none` and nothing else.

## 4. What is still open

1. **Arm 2 must be re-run, and it needs a human.** The OpenAI account has zero
   API credits — HTTP 429 `credit_balance_exhausted`, re-verified by direct probe
   at 09:40Z. Adding credits is a payment action no agent here can take.
   Everything else is staged: add credits, then
   `SWB_TESTBED_NETWORK=none ./run-45.sh --lane r99` (a fresh lane id; `r98` is
   burned and marked void), then
   `node breach-scan.mjs --ledger fullbench/rerun-r99/manifest.jsonl --logs
   fullbench/rerun-r99/logs --journals fullbench/rerun-r99/journals --require none
   --out fullbench/rerun-r99`, then `compare-arms.mjs` against
   `fullbench/codex-none-manifest.jsonl`. The subject pin makes it a
   single-variable comparison against `r97`.
2. **The four-cell in this report is provisional in one direction only.** If a
   sealed flows lane reproduces `r97`, the table stands as written. If it loses
   instances, the codex-only column grows and the superset goal goes back to
   failing. It cannot gain instances: taking the network away cannot help.
3. **The historical cost comparison is not independently reproducible.** It
   needs the derivation program, a deterministic replay check and scrubbed
   immutable input artifacts (or an accessible archive with hashes), followed
   by regenerated tables. A future run retaining token counters would measure
   that run; it would not supply the missing evidence for this comparison.
4. **The preflight network probe covers 3 of 8 repository families.** Any claim
   that `--network none` changed no graded test rests on 3 probed instances plus
   the per-instance evaluator reports for the 4 that moved.
5. **A lane that cannot get a model served scores itself as 35 empty patches.**
   `run-45.sh`'s failure classification cannot distinguish a provider outage from
   an agent that produced nothing. `r98` is the first lane to hit it and the
   marker file is a manual patch over a rig gap.

## Artifacts

Paths below are relative to `packages/smithers/agent/harness/benchmarks/swebench/`.
The absent entries are historical source locations, not downloadable evidence.
No accessible archive or hashes for those inputs are linked.

| what | where | published status |
| --- | --- | --- |
| codex `r90n` ledger | `fullbench/codex-none-manifest.jsonl` | absent |
| codex `r90n` archive | `fullbench/codex-none/` (logs, patches, reports, timings) | source artifacts absent; derivation prose only |
| codex `r90n` lane report | `fullbench/codex-none/lanes.md` | absent |
| codex `r90n` breach scan | `fullbench/codex-none/breach-scan.{md,json}` | absent |
| codex `r90n` cost derivation | [cost-derivation.md](../codex-none/cost-derivation.md) | prose only; not independently reproducible |
| flows `r97` ledger | `fullbench/rerun-r97/manifest.jsonl` | absent |
| flows `r97` journals (cost source) | `fullbench/rerun-r97/journals/` | absent |
| flows `r97` wave report | [rerun-r97.md](rerun-r97.md) | historical report, not raw inputs |
| flows `r98` void marker | `fullbench/rerun-r98/VOID.json` | absent |
| flows `r98` breach scan | `fullbench/rerun-r98/breach-scan.{md,json}` | absent |
| breach-scan outcome-reading fix | commit `da332216d` | historical code reference, not run inputs |
| the cost derivation's script | `derive-codex-cost.mjs` | absent; no executable replay check |
| evaluator run ids | `fullbench-codex-none`, `rerun-r97`, `rerun-r98` | identifiers only |

The original report attributed its numbers to those ledgers, journals and
transcripts, but this snapshot publishes neither those inputs nor the cost
derivation program. The printed totals, parameter sweep and per-instance rows
cannot establish that the parser and source counters produced them. In
particular, `measured` on the flows column does not make the 1.51× comparison
independently auditable.

The `r98` shape (34 runs with zero model calls, 1 with one call, 10 complete;
$6.41 spent) and its difference from the run-time note of "33 under 10 s" are
also retained as historical reports, not a ledger replay performed here.
