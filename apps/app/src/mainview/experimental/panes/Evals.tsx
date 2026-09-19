/*
 * Mock: Evals. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.evals`. Self-contained on purpose — see ../Pane.ts.
 *
 * A unit test asserts equality. A model answer is only better or worse than
 * the last one, so the picture is the pair of bars: the committed baseline
 * beside this run, per case. The two step keys under them are what
 * Regression.compare reads — a drop at a changed step key is a regression, the
 * same drop at an unchanged one is nondeterminism — and Gate.check turns the
 * pile into an exit code.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Facts, Rail, Section, Split, Table } from "../Primitives"

const NO_OBSERVATION = -1

const CASES = [
  {
    id: "changelog/breaking",
    finding: "regression",
    tone: "bad" as const,
    note: "−0.29",
    scorerName: "rubric-completeness",
    scorerKey: "9f4c1d…a210",
    baseline: 0.91,
    run: 0.62,
    baselineStepKey: "step_4c1a…9d2",
    runStepKey: "step_88f0…b13",
    latencyMs: "2 140 ms",
    reason: "two removed exports unlisted"
  },
  {
    id: "changelog/fixes",
    finding: "nondeterminism",
    tone: "warn" as const,
    note: "−0.19",
    scorerName: "judge-tone",
    scorerKey: "31bd07…4e88",
    baseline: 0.74,
    run: 0.55,
    baselineStepKey: "step_0ab3…77e",
    runStepKey: "step_0ab3…77e",
    latencyMs: "3 902 ms",
    reason: "same step key, moved score"
  },
  {
    id: "summary/short",
    finding: "matched",
    tone: "ok" as const,
    note: "+0.15",
    scorerName: "rubric-completeness",
    scorerKey: "9f4c1d…a210",
    baseline: 0.66,
    run: 0.81,
    baselineStepKey: "step_51de…c04",
    runStepKey: "step_a7b2…118",
    latencyMs: "1 488 ms",
    reason: "rose at a changed step key"
  },
  {
    id: "changelog/features",
    finding: "matched",
    tone: "muted" as const,
    note: "0.00",
    scorerName: "exact-match",
    scorerKey: "c0e2f4…9a31",
    baseline: 0.88,
    run: 0.88,
    baselineStepKey: "step_6f10…a39",
    runStepKey: "step_6f10…a39",
    latencyMs: "940 ms",
    reason: "unchanged"
  },
  {
    id: "changelog/empty",
    finding: "matched",
    tone: "muted" as const,
    note: "0.00",
    scorerName: "exact-match",
    scorerKey: "c0e2f4…9a31",
    baseline: 1,
    run: 1,
    baselineStepKey: "step_2277…e5a",
    runStepKey: "step_2277…e5a",
    latencyMs: "118 ms",
    reason: "unchanged"
  },
  {
    id: "summary/long",
    finding: "inconclusive",
    tone: "warn" as const,
    note: "inconclusive",
    scorerName: "judge-tone",
    scorerKey: "31bd07…4e88",
    baseline: 0.7,
    run: NO_OBSERVATION,
    baselineStepKey: "step_bb41…207",
    runStepKey: "step_bb41…207",
    latencyMs: "30 000 ms",
    reason: "judge returned no parsable score"
  },
  {
    id: "tone/neutral",
    finding: "missing",
    tone: "warn" as const,
    note: "missing run",
    scorerName: "judge-tone",
    scorerKey: "31bd07…4e88",
    baseline: 0.83,
    run: NO_OBSERVATION,
    baselineStepKey: "step_d904…6fc",
    runStepKey: "—",
    latencyMs: "—",
    reason: "executor: target refused the case"
  },
  {
    id: "tone/excited",
    finding: "matched",
    tone: "muted" as const,
    note: "0.00",
    scorerName: "judge-tone",
    scorerKey: "31bd07…4e88",
    baseline: 0.79,
    run: 0.79,
    baselineStepKey: "step_ff3c…480",
    runStepKey: "step_ff3c…480",
    latencyMs: "3 210 ms",
    reason: "unchanged"
  }
]

const FINDINGS = [
  { id: "changelog/breaking", kind: "regression", tone: "bad" as const, scorer: "rubric-completeness", move: "drop 0.29" },
  { id: "changelog/fixes", kind: "nondeterminism", tone: "warn" as const, scorer: "judge-tone", move: "delta −0.19" },
  { id: "tone/neutral", kind: "missing", tone: "warn" as const, scorer: "judge-tone", move: "side: run" },
  { id: "summary/long", kind: "inconclusive", tone: "warn" as const, scorer: "judge-tone", move: "no score" }
]

export const Pane = pane({
  id: "evals",
  title: "Evals",
  summary: "Suites, cases, baselines and the gate",
  packages: ["@smthrs/evals"],
  render: (context) => <EvalsBody {...context} />
})

function EvalsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const caseName = typeof props.caseName === "string" ? props.caseName : "changelog/breaking"
  const selected = CASES.find((row) => row.id === caseName) ?? CASES[0]
  if (selected === undefined) return null
  const observed = selected.run !== NO_OBSERVATION
  return (
    <Split
      left={
        <>
          <Section title="Suite">
            <Facts rows={[
              { label: "name", value: "release-notes", mono: true },
              { label: "cases", value: "8 of 10 000", mono: true },
              { label: "concurrency", value: "4", mono: true },
              { label: "runId", value: "nightly-2026-09-18", mono: true },
              { label: "baseline", value: "version 1 · committed", mono: true },
              { label: "tolerances", value: "absolute 0.02 · relative 0", mono: true }
            ]} />
          </Section>
          <Section title="Cases">
            <Rail
              items={CASES.map((row) => ({ id: row.id, label: row.id, note: row.note, tone: row.tone }))}
              selected={caseName}
              onSelect={(id) => runCommandSet("caseName", id)}
            />
          </Section>
        </>
      }
      right={
        <>
          <Section title={selected.id} right={<Badge tone={selected.tone}>{selected.finding}</Badge>}>
            {observed
              ? (
                <Bars
                  max={1}
                  rows={[
                    { label: "baseline", value: selected.baseline, display: selected.baseline.toFixed(2), tone: "muted" },
                    { label: "run", value: selected.run, display: selected.run.toFixed(2), tone: selected.tone }
                  ]}
                />
              )
              : (
                <Bars
                  max={1}
                  rows={[{ label: "baseline", value: selected.baseline, display: selected.baseline.toFixed(2), tone: "muted" }]}
                />
              )}
          </Section>
          <Section title="Step key" right={selected.baselineStepKey === selected.runStepKey ? "unchanged" : "changed"}>
            <Facts rows={[
              { label: "baseline.stepKey", value: selected.baselineStepKey, mono: true },
              { label: "run.stepKey", value: selected.runStepKey, mono: true },
              { label: "scorer", value: selected.scorerKey, mono: true },
              { label: "scorerName", value: selected.scorerName, mono: true },
              { label: "latencyMs", value: selected.latencyMs, mono: true },
              { label: "reason", value: selected.reason }
            ]} />
          </Section>
          <Section title="Findings" right={<Badge tone="bad">2 red · 2 withheld</Badge>}>
            <Table
              columns={[
                { key: "kind", label: "Kind" },
                { key: "case", label: "Case", mono: true },
                { key: "scorer", label: "Scorer", mono: true },
                { key: "move", label: "Move", mono: true, right: true }
              ]}
              rows={FINDINGS.map((row) => ({
                id: row.id,
                kind: <Badge tone={row.tone}>{row.kind}</Badge>,
                case: row.id,
                scorer: row.scorer,
                move: row.move
              }))}
              selected={caseName}
              onSelect={(id) => runCommandSet("caseName", id)}
            />
          </Section>
          <Section title="Gate" right={<Badge tone="bad">Failed</Badge>}>
            <Facts rows={[
              { label: "mean", value: "0.74 / 0.80", mono: true },
              { label: "min", value: "0.55 / 0.50", mono: true },
              { label: "perCase", value: "changelog/breaking 0.62 / 0.85", mono: true },
              { label: "exitCode", value: "1", mono: true }
            ]} />
          </Section>
        </>
      }
    />
  )
}
