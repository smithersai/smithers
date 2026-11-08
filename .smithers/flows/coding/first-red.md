# First red across a stack

`first-red.ts` exports `FirstRed` (`coding/FirstRed`) and `firstRedLayers`. It
answers one question about a long stack of Changes: which Change first broke
each check that fails at the tip. The Changes may come from many authors. The
answer is the input a correction needs: the earliest failing Change, its
failing receipt and its findings.

```text
tip ──▶ reproduce ──▶ last green ──▶ bisect by Change ──▶ verdicts + first red
```

```ts
const result = yield * FirstRed.execute({ range, checks, tries: 2 })
```

## Input

| Field    | Meaning                                                                                    |
| -------- | ------------------------------------------------------------------------------------------ |
| `range`  | `Implementation`s in stack order: the last green Change first, the newest tip last (2–256) |
| `checks` | The checks to run at the tip, usually the slow tier                                        |
| `tries`  | Runs at the tip before a failing check counts as broken (1–5, default 2)                   |

The range must be one parent chain: each Change's `parent.commitId` is the
`head.commitId` of the Change before it. A repeated Change or check refuses the
request with `invalid_request`.

## What runs

Every probe is an ordinary `coding/check` (`RunCheck`) call on one Change's
head, so its receipt binds the JJ commit, tree and input digest. A receipt for
another revision fails the search with `invalid_receipt`; a check that cannot
execute fails it with the check's own error.

1. **Tip.** Every check runs once at the tip. A check that passes is done and
   never runs again.
2. **Reproduce.** A failing check reruns at the tip until it passes (`flaky`)
   or has failed `tries` times.
3. **Last green.** The check runs once at the first Change of the range. A
   failure there is `broken-at-good`: search again from an older green.
4. **Bisect.** The check runs at the untested Change nearest the middle of the
   interval between its last pass and its first failure, until no Change is
   left between them. That Change is the check's first red.

All failing checks search in parallel, one probe per check per round. A check
needs `tries + 1 + ⌈log2(range − 1)⌉` runs at most, without skips or unmeasured tip reruns.

Each round is one trampoline round of `coding/FirstRedRound`, and the cursor is
its whole state. The engine journals every probe: running a finished search's
execution id again, on any host, returns the recorded result and runs no check.

## Infrastructure faults

A receipt with `fault: "infra"` did not measure the revision.

| Where      | Effect                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Tip        | First run: the check is `untestable`; nothing is blamed. A rerun: spends no try; the tip runs at most 5 times, then the recorded failure stands |
| Last green | The check is `untestable`: with no measured lower bound, no Change can be blamed                                                                |
| Bisect     | The Change is skipped, as `git bisect skip`; if it sits just below the answer it is in `candidates`                                             |

## Result

| Field      | Meaning                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `status`   | `green` when every check passed or only flaked at the tip; otherwise `red`                                 |
| `firstRed` | The earliest Change any `broken` check first fails at: `change`, `commitId`, `checks` and their `findings` |
| `checks`   | Per check: `verdict`, `change` (for `broken`), `candidates`, `failing` and `passing` receipts, `runs`      |

| Verdict          | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `broken`         | Fails every try at the tip, passes at the last green                                 |
| `flaky`          | Failed at the tip, then passed there                                                 |
| `broken-at-good` | Fails at the last green too                                                          |
| `untestable`     | An infrastructure fault kept it from measuring the tip's first run or the last green |
| `passed`         | Passed at the tip                                                                    |

`findings` keep each failing receipt's owner, so they are feedback a
correction of `firstRed.change` can read directly. `FirstRed` edits nothing.

## Host composition

Merge `firstRedLayers` with the host's `coding/check` implementation:
`checkLayers` from `checks.vibe` for command checks, or another registered
delegate. The test (`test/coding-first-red.test.ts`) bisects a real JJ stack of
33 Changes from four authors with checks that read each commit's files, and
replays the run on a new host without running a check again.

Prior art: VibeLang's `.smithers/flows/first-bad` flow, which reproduces a
post-merge RED at the bad commit and bisects it from the last good one.
