/*
 * Mock: Scorers. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.scorers`. Self-contained on purpose — see ../Pane.ts.
 *
 * A scorer is a declaration — id, version, optional config, one `score`
 * returning [0, 1] — hashed into the `scorerKey` written on every row it ever
 * produces. The half worth drawing is the sampling decision: `Sampling.decide`
 * hashes (targetStepKey, scorerKey, seed) and compares it with the ratio, so
 * the answer to "why is there no score for this step" is arithmetic, not luck.
 * A scorer that throws lands in `flows_scores` as an inconclusive observation
 * with a `failure_code`, never as a thrown error.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Code, Facts, Rail, Section, Split, Table } from "../Primitives"

const SCORERS = [
  {
    id: "rubric-completeness",
    label: "rubric-completeness",
    note: "ratio 0.25",
    tone: "info" as const,
    scorerId: "acme/scorers/rubric-completeness",
    version: "2",
    scorerKey: "9f4c1d…a210",
    appliesTo: "releaseNotes",
    sampling: "{ ratio: 0.25, seed: \"2026-q3\" }",
    config: `{
  "rubric": ["breaking", "features", "fixes"],
  "weights": { "breaking": 0.5, "features": 0.3, "fixes": 0.2 }
}`,
    targetStepKey: "step_88f0…b13",
    seed: "2026-q3",
    hash: 0.1841,
    ratio: 0.25,
    sampled: true
  },
  {
    id: "judge-tone",
    label: "judge-tone",
    note: "ratio 0.05",
    tone: "muted" as const,
    scorerId: "acme/scorers/judge-tone",
    version: "3",
    scorerKey: "31bd07…4e88",
    appliesTo: "issueTriage",
    sampling: "{ ratio: 0.05, seed: \"tone-a\" }",
    config: `{ "model": "judge", "scale": 5 }`,
    targetStepKey: "step_0ab3…77e",
    seed: "tone-a",
    hash: 0.4013,
    ratio: 0.05,
    sampled: false
  },
  {
    id: "exact-match",
    label: "exact-match",
    note: "all",
    tone: "ok" as const,
    scorerId: "@smthrs/evals/scorers/exact-match",
    version: "1",
    scorerKey: "c0e2f4…9a31",
    appliesTo: "greet",
    sampling: "\"all\"",
    config: "—",
    targetStepKey: "step_6f10…a39",
    seed: "—",
    hash: 1,
    ratio: 1,
    sampled: true
  },
  {
    id: "latency-budget",
    label: "latency-budget",
    note: "none",
    tone: "muted" as const,
    scorerId: "acme/scorers/latency-budget",
    version: "1",
    scorerKey: "7ae503…1c60",
    appliesTo: "reviewLoop",
    sampling: "\"none\"",
    config: `{ "budgetMs": 30000 }`,
    targetStepKey: "step_ff3c…480",
    seed: "—",
    hash: 0,
    ratio: 0,
    sampled: false
  }
]

const OBSERVATIONS = [
  { id: "412", at: "09:14:02", kind: "score", tone: "ok" as const, target: "step_88f0…b13", value: "0.62", code: "—" },
  { id: "411", at: "09:13:58", kind: "score", tone: "ok" as const, target: "step_4c1a…9d2", value: "0.91", code: "—" },
  { id: "409", at: "09:13:40", kind: "inconclusive", tone: "warn" as const, target: "step_bb41…207", value: "NULL", code: "inconclusive" },
  { id: "404", at: "09:12:11", kind: "inconclusive", tone: "bad" as const, target: "step_51de…c04", value: "NULL", code: "invalid_score" },
  { id: "398", at: "09:10:47", kind: "score", tone: "ok" as const, target: "step_a7b2…118", value: "0.81", code: "—" }
]

const JOBS = [
  { id: "j1", identity: "run-1 · greet/ada · 9f4c1d…", recorded: "persisted", tone: "ok" as const },
  { id: "j2", identity: "run-1 · greet/ada · 9f4c1d…", recorded: "duplicate", tone: "muted" as const },
  { id: "j3", identity: "run-1 · triage/812 · 31bd07…", recorded: "failed", tone: "bad" as const }
]

export const Pane = pane({
  id: "scorers",
  title: "Scorers",
  summary: "Every observation a scorer wrote, and why it sampled",
  packages: ["@smthrs/scorers"],
  render: (context) => <ScorersBody {...context} />
})

function ScorersBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const scorer = typeof props.scorer === "string" ? props.scorer : "rubric-completeness"
  const selected = SCORERS.find((row) => row.id === scorer) ?? SCORERS[0]
  if (selected === undefined) return null
  return (
    <Split
      left={
        <>
          <Section title="Declarations"><Rail items={SCORERS} selected={scorer} onSelect={(id) => runCommandSet("scorer", id)} /></Section>
          <Section title="Runner">
            <Facts rows={[
              { label: "capacity", value: "1024", mono: true },
              { label: "concurrency", value: "1", mono: true },
              { label: "queued", value: "37", mono: true },
              { label: "submit", value: "backpressures at capacity" },
              { label: "flows_score_jobs", value: "1 209 identities", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={selected.scorerId} right={<Badge tone="info">v{selected.version}</Badge>}>
            <Facts rows={[
              { label: "scorerKey", value: selected.scorerKey, mono: true },
              { label: "appliesTo", value: selected.appliesTo, mono: true },
              { label: "sampling", value: selected.sampling, mono: true },
              { label: "score", value: "Input → { score: [0, 1] }", mono: true }
            ]} />
            {selected.config === "—" ? null : <Code label="config">{selected.config}</Code>}
          </Section>
          <Section
            title="Sampling.decide"
            right={<Badge tone={selected.sampled ? "ok" : "muted"}>{selected.sampled ? "sampled" : "skipped"}</Badge>}
          >
            {selected.ratio > 0 && selected.ratio < 1
              ? (
                <Bars
                  max={1}
                  rows={[
                    { label: "hash", value: selected.hash, display: selected.hash.toFixed(4), tone: selected.sampled ? "ok" : "muted" },
                    { label: "ratio", value: selected.ratio, display: selected.ratio.toFixed(2), tone: "info" }
                  ]}
                />
              )
              : null}
            <Facts rows={[
              { label: "targetStepKey", value: selected.targetStepKey, mono: true },
              { label: "seed", value: selected.seed, mono: true }
            ]} />
          </Section>
          <Section title="flows_scores" right={<Badge tone="info">n 412 · mean 0.78 · min 0.55</Badge>}>
            <Table
              columns={[
                { key: "at", label: "at_ms", mono: true },
                { key: "target", label: "target_step_key", mono: true },
                { key: "kind", label: "kind" },
                { key: "code", label: "failure_code", mono: true },
                { key: "value", label: "value", mono: true, right: true }
              ]}
              rows={OBSERVATIONS.map((row) => ({
                id: row.id,
                at: row.at,
                target: row.target,
                kind: <Badge tone={row.tone}>{row.kind}</Badge>,
                code: row.code,
                value: row.value
              }))}
            />
          </Section>
          <Section title="runBatch">
            <Table
              columns={[
                { key: "identity", label: "identity", mono: true },
                { key: "recorded", label: "recorded", right: true }
              ]}
              rows={JOBS.map((row) => ({
                id: row.id,
                identity: row.identity,
                recorded: <Badge tone={row.tone}>{row.recorded}</Badge>
              }))}
            />
          </Section>
        </>
      }
    />
  )
}
