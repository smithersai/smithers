# Deriving a USD cost for the sealed-testbed codex arm

> **Evidence status: not independently reproducible.** The $37.38 scored
> ($38.73 raw) codex estimate and its comparison with flows are historical
> reported figures. This snapshot does not include the derivation program,
> codex transcripts and ledger, flows `r97` journals and ledger, or the two
> predecessor derivations. No accessible archive with hashes or deterministic
> replay check is linked. The tables and parser description below cannot
> substitute for the missing implementation and source evidence.

`r90n` is `r90sh` with one variable moved — `SWB_TESTBED_NETWORK=none`, so the
container the agent runs the project's tests in has `lo` and nothing else — and
it prints the same single `tokens used` footer with no input/cached/output
split. This note derives the split for the `none` lane using the **same method,
the same parameters and the same price table** as
`fullbench/codex-sealed/cost-derivation.md` and
`fullbench/codex-sealed-high/cost-derivation.md`, so the three lanes' dollars
are comparable to each other and not only to themselves.

Read those two notes first. Everything they establish — how a request sequence
is reconstructed from a transcript, why the footer is `Σ (non-cached input) + Σ
output` rather than a cumulative total, why non-cached input telescopes to the
final request's context, and the price table — is reused here and not
re-argued.

**Everything here is a model.** The inputs are 45 archived transcripts
(`fullbench/codex-none/logs/<id>.run.log`), the lane's ledger
(`fullbench/codex-none-manifest.jsonl`), and the committed price table
(`prices.ts`). No billing data exists for this arm either: `codex exec` runs
under `--ephemeral` (`run-instance-codex.sh:196`), so no rollout JSONL with a
real token split survives.

## Reported method and calibration

Neither earlier note published its script, so this note's derivation is a third
re-implementation, and it is calibrated by replaying it over **both** earlier
lanes' transcripts and checking it against their published tables before it is
pointed at anything new.

| quantity | published | this implementation replays | delta |
| --- | ---: | ---: | ---: |
| **`r90s`, at 4 / 10k / 3k** | | | |
| requests (45) | 646 | 646 | 0 |
| tool calls (45) | 601 | 601 | 0 |
| footer tokens (45) | 1,710,616 | 1,710,616 | 0 |
| modeled input (45) | 9,527,969 | 9,523,958 | −0.042 % |
| output+reasoning (45) | 703,486 | 701,498 | −0.283 % |
| USD low (45) | $30.40 | $30.35 | −$0.05 |
| USD high (45) | $68.74 | $68.66 | −$0.08 |
| scored-43 USD low | $29.29 | $29.24 | −$0.05 |
| **`r90sh`, at 4 / 10k / 0** | | | |
| requests (45) | 729 | 729 | 0 |
| tool calls (45) | 684 | 684 | 0 |
| footer tokens (45) | 1,982,783 | 1,982,783 | 0 |
| modeled input (45) | 11,910,682 | 11,920,995 | +0.087 % |
| output+reasoning (45) | 880,740 | 876,706 | −0.458 % |
| USD low (45) | $37.34 | $37.24 | −$0.10 |
| USD high (45) | $85.98 | $85.91 | −$0.07 |
| scored-43 USD low | $35.90 | $35.81 | −$0.09 |

Requests, tool calls and footers are **exact** on both lanes — the parse is not
in question. The residual is in the character counting, it is under half a
percent on the derived output, and it runs in one direction: this
implementation reads a slightly larger final request, so it derives slightly
**less** output and therefore a slightly **lower** dollar figure than either
published note. Every comparison in this note is between numbers this
implementation produced, so the residual cancels; where a published figure is
quoted beside one of ours, the published one is named as published.

**The derivation program is not published.** The original note described a
170-line ES module, `derive-codex-cost.mjs`, taking `--logs <dir>`, `--chars`,
`--cap`, `--system` and `--sweep`. Its reported parser splits a transcript on
bare marker lines (`user`, `codex`, `exec`, `apply patch`, `tokens used`),
drops the banner before the first `user`, counts block characters at
`floor(chars / 4)`, caps each tool result, and emits a request's input after
each tool call. This description is not an executable method: the calibration
above records character-counting discrepancies between implementations. All
replay and calibration results in this note are historical reports, not
checks a reader can execute from this snapshot.

The 27-cell sensitivity sweep replays too. **Twenty-five of `r90sh`'s 27 cells
reproduce their published `infeasible` count exactly**, including every cell
that decides a parameter choice: 0 at 4 / 10k / 0, and 1 at both 4 / 10k / 3k
and 4 / 10k / 6k, which is the rejection that forced `r90sh` off the `r90s`
headline parameters. The two that differ — 3.6 / 4k / 6k (0 published, 1 here)
and 3.6 / 16k / 3k (2 published, 3 here) — are corner cells that neither note
selects, and each differs by one run. Across all 27 cells the largest USD-low
disagreement is $0.44, at a corner; at the headline cell it is $0.10.

## Parameters

`chars/token = 4`, `tool-output cap = 10,000 tokens`, `system overhead = 0`.

**That is `r90sh`'s parameter set, kept unchanged so the medium → high → sealed
progression is priced on one basis.** Unlike `r90sh`, this lane does not
*require* it: at 4 / 10k / 3,000 the `none` lane leaves all 45 runs feasible,
so the `r90s` headline set is available here. It is not used, because a
delta between two lanes priced at two parameter sets is a parameter change
wearing a result's clothes.

Setting the system overhead to 0 makes the modeled input a lower bound on
context and therefore the derived output an upper bound, which is the
conservative direction for a cost figure.

## Price

`prices.ts`, verified in file and unchanged: gpt-5.6-sol at **$5.00/M** uncached
input, **$0.50/M** cached input, **$30.00/M** output (reasoning included in
output, not billed twice).

- **USD low (with cache)** — `novel × $5 + cached × $0.50 + output × $30`.
- **USD high (no cache)** — `total_input × $5 + output × $30`.

## What the sealed testbed did to the reconstruction

Both lanes priced at 4 / 10k / 0 by this one implementation, so nothing below is
a parameter artefact or a cross-implementation artefact:

| | `r90sh` (testbed `bridge`) | `r90n` (testbed `none`) | change |
| --- | ---: | ---: | ---: |
| tool calls | 684 | 683 | −0.1 % |
| requests | 729 | 728 | −0.1 % |
| footer tokens | 1,982,783 | 2,008,260 | +1.3 % |
| modeled input | 11,920,995 | 12,223,281 | +2.5 % |
| cached share | 90.7 % | 91.1 % | +0.4 pt |
| output+reasoning | 876,706 | 924,763 | +5.5 % |
| agent wall clock (ledger, raw 45) | 6,229 s | 5,415 s | **−13.1 %** |
| USD low, raw 45 | $37.24 | **$38.73** | **+4.0 %** |
| USD low, scored 43 | $35.81 | **$37.38** | **+4.4 %** |
| runs whose implied output goes negative | 0 | 0 | — |

**Taking the network away from the testbed made the lane slightly dearer and
noticeably faster.** The same number of requests carried 1.3 % more footer
tokens and 5.5 % more derived output, while the agent's own wall clock fell
13 %. The reading the artifacts support is that the eight `r90sh` runs that
fetched upstream hindsight spent wall clock waiting on the network and then
short-cut the reasoning; without that route the lane thinks a little more and
waits a lot less. It is consistent, it is not proof, and no artifact in this
tree can settle it.

**The ratio is steadier than the level.** Pricing both lanes at every setting
and taking `r90n ÷ r90sh`:

| | value |
| --- | --- |
| settings feasible in **both** lanes | 15 of 27 |
| `r90n ÷ r90sh` across those 15 | **1.038 – 1.054** |
| `r90n ÷ r90sh` across all 27, feasible or not | 1.038 – 1.060 |

**What sealing the testbed cost in dollars is a +4 % ±1 % answer whichever
feasible parameter set you pick**, even though the absolute level moves by a
quarter across the band.

## Per instance

| instance | requests | footer tokens | modeled input | cached share | output+reasoning | USD low (cache) | USD high (no cache) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `astropy__astropy-14365` | 6 | 28,524 | 41,561 | 75.3 % | 18,265 | $0.6149 | $0.7558 |
| `astropy__astropy-14369` | 15 | 69,035 | 284,686 | 88.6 % | 36,665 | $1.3880 | $2.5234 |
| `astropy__astropy-7166` | 7 | 19,498 | 18,960 | 76.9 % | 15,110 | $0.4825 | $0.5481 |
| `astropy__astropy-8707` | 13 | 46,819 | 206,335 | 85.9 % | 17,661 | $0.7642 | $1.5615 |
| `django__django-10914` | 15 | 38,941 | 167,914 | 85.4 % | 14,384 | $0.6260 | $1.2711 |
| `django__django-11299` | 11 | 37,743 | 128,036 | 85.2 % | 18,795 | $0.7131 | $1.2040 |
| `django__django-11490` | 20 | 46,056 | 251,528 | 91.5 % | 24,713 | $0.9632 | $1.9990 |
| `django__django-11815` | 17 | 34,185 | 126,007 | 90.4 % | 22,106 | $0.7805 | $1.2932 |
| `django__django-12273` | 20 | 56,575 | 341,391 | 92.0 % | 29,404 | $1.1751 | $2.5891 |
| `django__django-12741` | 14 | 27,491 | 87,914 | 86.9 % | 15,954 | $0.5745 | $0.9182 |
| `django__django-13128` | 28 | 51,492 | 552,487 | 94.5 % | 20,967 | $1.0426 | $3.3914 |
| `django__django-13212` | 23 | 51,127 | 430,855 | 90.5 % | 10,213 | $0.7059 | $2.4607 |
| `django__django-13343` | 10 | 31,369 | 74,128 | 76.9 % | 14,239 | $0.5413 | $0.7978 |
| `django__django-13346` | 17 | 48,053 | 336,878 | 91.1 % | 18,124 | $0.8468 | $2.2281 |
| `django__django-13406` | 11 | 29,380 | 93,555 | 87.1 % | 17,313 | $0.6205 | $0.9872 |
| `django__django-13821` | 17 | 59,448 | 301,766 | 91.3 % | 33,268 | $1.2667 | $2.5069 |
| `django__django-14351` | 29 | 66,644 | 601,051 | 94.7 % | 34,524 | $1.4808 | $4.0410 |
| `django__django-15380` | 10 | 41,557 | 191,141 | 84.4 % | 11,815 | $0.5839 | $1.3102 |
| `django__django-15569` | 11 | 27,826 | 54,940 | 80.6 % | 17,149 | $0.5900 | $0.7892 |
| `django__django-15732` | 18 | 45,219 | 262,504 | 90.5 % | 20,207 | $0.8500 | $1.9187 |
| `django__django-15987` | 18 | 29,293 | 127,179 | 91.5 % | 18,526 | $0.6678 | $1.1917 |
| `django__django-16612` | 9 | 30,923 | 84,263 | 82.3 % | 16,010 | $0.5895 | $0.9016 |
| `django__django-16662` | 8 | 28,739 | 65,086 | 81.0 % | 16,370 | $0.5793 | $0.8165 |
| `django__django-16899` | 15 | 25,608 | 83,233 | 87.6 % | 15,283 | $0.5466 | $0.8747 |
| `django__django-16901` | 17 | 44,487 | 246,362 | 90.0 % | 19,748 | $0.8269 | $1.8243 |
| `matplotlib__matplotlib-20826` | 13 | 37,224 | 145,856 | 88.4 % | 20,323 | $0.7587 | $1.3390 |
| `matplotlib__matplotlib-20859` | 10 | 34,499 | 68,287 | 78.5 % | 19,822 | $0.6948 | $0.9361 |
| `matplotlib__matplotlib-22865` | 12 | 35,753 | 125,732 | 87.6 % | 20,104 | $0.7364 | $1.2318 |
| `matplotlib__matplotlib-24970` | 17 | 39,192 | 110,167 | 87.3 % | 25,208 | $0.8743 | $1.3071 |
| ⟂ `psf__requests-1766` | 10 | 32,990 | 90,623 | 81.6 % | 16,353 | $0.6108 | $0.9437 |
| ⟂ `psf__requests-2317` | 19 | 42,839 | 232,071 | 88.8 % | 16,866 | $0.7389 | $1.6663 |
| `pydata__xarray-7229` | 18 | 63,929 | 310,813 | 89.6 % | 31,685 | $1.2511 | $2.5046 |
| `pydata__xarray-7233` | 12 | 32,814 | 79,363 | 83.3 % | 19,526 | $0.6853 | $0.9826 |
| `pydata__xarray-7393` | 18 | 38,616 | 189,537 | 89.3 % | 18,401 | $0.7378 | $1.4997 |
| `pytest-dev__pytest-6197` | 31 | 76,085 | 708,768 | 93.6 % | 31,045 | $1.4884 | $4.4752 |
| `sphinx-doc__sphinx-11445` | 14 | 51,236 | 152,535 | 85.5 % | 29,156 | $1.0503 | $1.6374 |
| `sphinx-doc__sphinx-7590` | 46 | 84,017 | 1,242,600 | 95.2 % | 24,764 | $1.6309 | $6.9559 |
| `sphinx-doc__sphinx-7757` | 11 | 53,464 | 210,364 | 84.3 % | 20,427 | $0.8667 | $1.6646 |
| `sphinx-doc__sphinx-8721` | 11 | 61,410 | 255,626 | 80.7 % | 12,012 | $0.7105 | $1.6385 |
| `sympy__sympy-13372` | 8 | 25,338 | 29,547 | 75.3 % | 18,035 | $0.5887 | $0.6888 |
| `sympy__sympy-13878` | 49 | 135,022 | 2,672,273 | 95.5 % | 13,695 | $2.2930 | $13.7722 |
| `sympy__sympy-16450` | 10 | 35,956 | 70,038 | 81.9 % | 23,285 | $0.7906 | $1.0487 |
| `sympy__sympy-18763` | 9 | 31,551 | 41,307 | 80.7 % | 23,595 | $0.7643 | $0.9144 |
| `sympy__sympy-19495` | 18 | 42,910 | 186,512 | 91.3 % | 26,654 | $0.9660 | $1.7322 |
| `sympy__sympy-20154` | 13 | 37,383 | 141,502 | 85.6 % | 16,994 | $0.6723 | $1.2173 |
| **total (45)** | **728** | **2,008,260** | **12,223,281** | **91.1 %** | **924,763** | **$38.73** | **$88.86** |

⟂ marks an instance `lib/excluded.mjs` keeps out of every rate, for both arms.

Scored population (43, excluding `psf__requests-1766` and `psf__requests-2317`
by name): **$37.38** low, **$86.25** high, over 699 requests and 1,932,431
footer tokens, at a 91.3 % cached share and 891,544 derived output tokens.

Per instance: mean $0.8607 low / $1.9747 high; range $0.4825–$2.2930 low
(`r90sh`'s was $0.4208–$1.9931, `r90s`'s $0.2897–$1.3391).

## Sensitivity

The three modelling parameters, swept together, exactly as both earlier notes
sweep them. `infeasible` counts runs whose implied output goes negative; a
setting with any is rejected.

| chars/token | tool cap | system tokens | infeasible | total USD low | total USD high |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3.6 | 4,000 | 0 | 0 | $40.28 | $87.53 |
| 3.6 | 4,000 | 3,000 | 0 | $37.93 | $94.40 |
| 3.6 | 4,000 | 6,000 | 0 | $35.57 | $101.27 |
| 3.6 | 10,000 | 0 | 0 | $36.71 | $91.84 |
| 3.6 | 10,000 | 3,000 | 0 | $34.36 | $98.71 |
| 3.6 | 10,000 | 6,000 | **1** | $32.01 | $105.58 |
| 3.6 | 16,000 | 0 | **1** | $35.47 | $92.90 |
| 3.6 | 16,000 | 3,000 | **2** | $33.12 | $99.77 |
| 3.6 | 16,000 | 6,000 | **3** | $30.77 | $106.64 |
| 4 | 4,000 | 0 | 0 | $41.81 | $85.53 |
| 4 | 4,000 | 3,000 | 0 | $39.46 | $92.40 |
| 4 | 4,000 | 6,000 | 0 | $37.11 | $99.27 |
| 4 | 10,000 | 0 | 0 | **$38.73** | **$88.86** |
| 4 | 10,000 | 3,000 | 0 | $36.38 | $95.73 |
| 4 | 10,000 | 6,000 | 0 | $34.03 | $102.60 |
| 4 | 16,000 | 0 | 0 | $37.69 | $89.93 |
| 4 | 16,000 | 3,000 | 0 | $35.34 | $96.80 |
| 4 | 16,000 | 6,000 | **1** | $32.99 | $103.67 |
| 4.5 | 4,000 | 0 | 0 | $43.41 | $83.33 |
| 4.5 | 4,000 | 3,000 | 0 | $41.06 | $90.20 |
| 4.5 | 4,000 | 6,000 | 0 | $38.71 | $97.07 |
| 4.5 | 10,000 | 0 | 0 | $40.89 | $85.86 |
| 4.5 | 10,000 | 3,000 | 0 | $38.54 | $92.73 |
| 4.5 | 10,000 | 6,000 | 0 | $36.19 | $99.60 |
| 4.5 | 16,000 | 0 | 0 | $39.95 | $86.96 |
| 4.5 | 16,000 | 3,000 | 0 | $37.60 | $93.83 |
| 4.5 | 16,000 | 6,000 | 0 | $35.25 | $100.70 |

**Twenty-two of the 27 settings are feasible for this lane** — more than
`r90sh`'s 16 — and across them the total runs **$34.03 to $43.41** with cache
and **$83.33 to $101.27** without. The headline $38.73 sits near the middle of
that band, not at an edge.

## The dominant uncertainty is still cache efficiency, and it still points down

The per-run model assumes ideal prefix caching, which reaches a lane-wide
**91.1 %** cached share (against `r90sh`'s 90.7 % and `r90s`'s 89.4 %). Because
the footer pins `non-cached input + output`, a worse cache means more non-cached
input and necessarily *less* output, and output bills at 6× input, so **worse
caching implies a lower derived cost, not a higher one**.

Applying a single uniform cached share to the whole lane, which is coarser than
the per-run telescoping model and so rules out more:

| assumed cached share | non-cached input | implied output | output per request | total USD | verdict |
| ---: | ---: | ---: | ---: | ---: | --- |
| 84.0 % | 1,955,725 | 52,535 | 72 | $16.49 | 7 runs negative — ruled out |
| 86.0 % | 1,711,259 | 297,001 | 408 | $22.72 | 6 runs negative — ruled out |
| 88.0 % | 1,466,794 | 541,466 | 744 | $28.96 | 6 runs negative — ruled out |
| 89.5 % | 1,283,445 | 724,815 | 996 | $33.63 | 3 runs negative — ruled out |
| 90.5 % | 1,161,212 | 847,048 | 1,164 | $36.75 | 3 runs negative — ruled out |
| **91.1 % (ideal, per run)** | **1,083,497** | **924,763** | **1,270** | **$38.73** | feasible |

The footers are only jointly satisfiable near the ideal split, so $38.73 is a
point estimate rather than the top of a wide band — and on the cache axis
specifically it is a **ceiling**.

## Against the flows arm

The flows arm needs no modelling: `fullbench/rerun-r97/journals` records all four
token counters per model call, and `lib/run-cost.mjs` read over the 45 journals
gives **$25.5223 raw (45) / $24.7018 scored (43)** — 5,474,701 input tokens of
which 1,797,620 (32.8 %) cached, 207,940 output (98,337 of it reasoning), over
303 model calls. The original report said that the ledger's per-instance
`cost.usd` rows agreed with the journal projection to the last cent. Neither
input is published here, so that agreement cannot be independently checked.

| arm | testbed | basis | raw (45) | scored (43) |
| --- | --- | --- | ---: | ---: |
| flows `r97` | `bridge` (unrecorded) | **measured**, per-call journal counters | **$25.52** | **$24.70** |
| codex `r90n` | **`none`, 45 of 45 observed** | modelled from transcripts, with cache | **$38.73** | **$37.38** |
| codex `r90n` | `none` | modelled, no-cache upper bound | $88.86 | $86.25 |
| codex `r90sh` | `bridge` | modelled, same implementation, same parameters | $37.24 | $35.81 |
| codex `r90s` | `bridge` | modelled, same implementation, at 4 / 10k / 3k | $30.35 | $29.24 |

**Historical cost comparison, not independently reproducible:** $38.73
modelled for codex against $25.52 reported as measured for flows, a 1.52× raw
ratio (1.51× scored). The reported 1.33×–1.70× sensitivity range across 22
feasible settings is also unverified without the missing program and inputs.
The driver is unchanged from both earlier notes and the sealed testbed did not move it: codex spent 728 requests to flows'
303 model calls, and about 1,270 derived output tokens per request against flows'
measured 686 per call — 924,763 output tokens against 207,940, at $30/M.

**The comparison's own caveat travels with it.** The flows column is `r97`,
which ran before `SWB_TESTBED_NETWORK=none` was recorded, so the two arms in
that table are not under one condition. The lane that would fix it, `r98`, is
void — see `fullbench/rerun-r98/VOID.json` — and its 10 attempted instances are
not a rate. What can be said about the flows column's exposure is in the
scoreboard, not here: `breach-scan.mjs` over `r97`'s ledger, driver logs and
journals counts **zero in-container fetches across all 45 runs**, and the only
two egress commands the scan finds anywhere in the lane are `pip install Pillow`
in `django__django-13343`.

## What independent reproduction requires

Publish the derivation program and a deterministic replay check, together with
scrubbed immutable transcripts, ledgers and flows journals, either in this
repository or in an accessible archive with hashes. Include the predecessor
lanes used for calibration, then regenerate the calibration, per-instance,
sensitivity and comparison tables from those inputs. Folding the printed tables
alone would check arithmetic, not the transcript parser or source counters.

A future codex run retaining `input_tokens`, `cached_input_tokens` and
`output_tokens` would replace modelling with measured counters for that run.
It would not recover the missing evidence for this historical comparison.
