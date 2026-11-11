# Review Seeded-Bug Scorecard

Two numbers live here, and they measure different things.

## The gate: the offline pipeline score

`baseline.json` records this run per fixture, and `bun
.smithers/flows/review/seeded-bugs/run.vibe` fails when a fixture disagrees with it. The
reviewing seat is `deterministicReviewer.ts`, so the score is reproducible and
free, and what it grades is the pipeline: diff ingestion, per-file fan-out,
scoping, anchoring, de-duplication, and the scorer's matching.

Each record holds the fixture's status, its matched, false-positive and missed
counts, and one anchor per planted bug naming the line the review anchored to
and the severity it assigned. Counts alone cannot see a finding that slides
inside the three-line match tolerance or one that keeps its line and drops from
critical to info, so the anchors are part of the gate.

Recorded 2026-09-08 against the rc.0 review flow:

| Metric | Value |
| --- | ---: |
| Fixtures | 16 |
| Planted bugs | 12 |
| Clean controls | 4 |
| Recall | 50.0% (6/12) |
| Precision | 85.7% (6/7) |
| F1 | 63.2% |
| Mean absolute anchor offset | 0 lines |
| Tight-anchor rate | 100% |
| Severity exact-match rate | 100% |
| Mean severity ordinal error | 0 |
| False positives on clean controls | 0 |

The offline reviewer has signals for four of the seven bug classes
(`missing-await`, `off-by-one-boundary`, `sql-injection`, `tautological-test`)
and none for the other three, and inside the classes it does cover it only
fires on the shapes its signals match. Six of the twelve planted bugs go
unfound.

### Missed fixtures

`baseline.json` records a missed planted bug for each of these, and
`score.test.ts` fails when this list and the baseline disagree.

- `cross-file-signature-mismatch`
- `deleted-null-check`
- `deleted-null-check-config`
- `off-by-one-boundary`
- `resource-leak`
- `resource-leak-timer`

That is the point: recall measures the reviewer, and the reviewer is
deliberately weak. Precision, anchor accuracy, severity calibration, and the
clean-control count measure the pipeline, and those are the numbers a code
change moves.

## The reference: a live model's score

`bun .smithers/flows/review/seeded-bugs/run.vibe --live` runs the same suite against real
seats and writes a timestamped report under `.report/`. It spends real inference
budget and is not a gate, because a model's score is not reproducible.

The snapshot below is illustrative and predates the rc.0 rewrite. Regenerate it
before quoting it.

| Metric | Value |
| --- | ---: |
| Recall | 71.4% |
| Precision | 62.5% |
| Mean absolute anchor offset | 1.2 lines |
| Tight-anchor rate | 80.0% |
| Severity exact-match rate | 60.0% |
| Mean severity ordinal error | 0.6 |

## Metrics

- **Recall:** matched planted bugs divided by all planted bugs.
- **Precision:** matched findings divided by matched findings plus false
  positives. Findings on clean controls count as false positives.
- **Anchor accuracy:** mean signed line offset, mean absolute line offset, and
  the fraction of matched findings within the tight line tolerance.
- **Severity calibration:** exact severity-match rate plus mean absolute ordinal
  error using `info < minor < major < critical`.

## Fixture layout

| Fixture | Label | Expected review behavior |
| --- | --- | --- |
| `missing-await` | correctness / major | Flag the dropped `await` near `src/order.ts`. |
| `missing-await-flush` | correctness / major | Flag the dropped await before the buffer save completes. |
| `off-by-one-boundary` | correctness / major | Flag the excluded boundary page near `src/window.ts`. |
| `off-by-one-slice` | correctness / major | Flag the decremented slice end that drops the final page item. |
| `sql-injection` | security / critical | Flag string interpolation in the SQL query. |
| `sql-injection-like` | security / critical | Flag interpolation of the search term into the LIKE query. |
| `resource-leak` | performance / major | Flag the removed file-handle close. |
| `resource-leak-timer` | performance / major | Flag the shutdown callback that no longer clears the interval. |
| `deleted-null-check` | correctness / major | Flag the removed null fallback. |
| `deleted-null-check-config` | correctness / major | Flag the removed log-level default fallback. |
| `tautological-test` | tests / minor | Flag the assertion that can never fail. |
| `cross-file-signature-mismatch` | correctness / major | Flag the caller still passing seconds after the helper changed to absolute milliseconds. |
| `clean-error-message` | clean control | Produce no findings. |
| `clean-refactor` | clean control | Produce no findings. |
| `clean-rename` | clean control | Produce no findings. |
| `clean-jsdoc` | clean control | Produce no findings. |
