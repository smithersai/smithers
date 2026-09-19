/*
 * Mock: Step cache. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.step-cache`. Self-contained on purpose — see ../Pane.ts.
 *
 * The question the product cannot answer today is why a step did NOT run.
 * Every row here is durable: the `flows_step_cache` head, the append-only
 * `flows_step_cache_recorded` ledger keyed by `(key_digest, recorded_run_id,
 * recorded_event_seq)`, the RFC 8785 canonical document the digest was taken
 * over, and the `@smthrs/artifacts` address that holds the bytes.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Code, Empty, Facts, Rail, Section, Split, Steps, Table } from "../Primitives"

type Tone = "ok" | "warn" | "bad" | "info" | "muted"

interface StepMock {
  readonly id: string
  readonly verdict: string
  readonly tone: Tone
  readonly keyDigest: string
  readonly source: string
  readonly createdAtMs: string
  readonly recordedRunId: string
  readonly recordedEventSeq: number
  readonly canonical: string
  readonly result: string
  readonly meta: string
  readonly artifact: string
  readonly bytes: string
  readonly tier: string
  readonly ladder: ReadonlyArray<{ readonly id: string; readonly label: string; readonly note: string; readonly tone: Tone }>
}

const STEPS: ReadonlyArray<StepMock> = [
  {
    id: "typecheck",
    verdict: "hit",
    tone: "ok",
    keyDigest: "key1_a71d03…5b6e",
    source: "head",
    createdAtMs: "1 758 142 004 118",
    recordedRunId: "run_2f10bc",
    recordedEventSeq: 118,
    canonical:
      `{"body":{"declaration":{"action":"tsc","project":"flows"},"version":"flows/key-material/v2"},"capabilities":{"declared":["fs:read:packages/**","proc:spawn:tsc"]},"environment":{"capabilities":{},"declared":true,"layers":["NodeFileSystem"]},"hermetic":{"boundaryMode":"hard","readSet":[{"digest":"4c9e21…1a20","path":"tsconfig.json"}],"writeSet":[{"_tag":"Glob","include":["**/*.tsbuildinfo"]}]},"inputs":{"0":{"digest":"key1_31b0f4…c9de","kind":"digest","reference":"ref"}},"kind":"content","layers":["NodeFileSystem"]}`,
    result: `{ "diagnostics": 0, "tsbuildinfo": "dist/.tsbuildinfo" }`,
    meta: `{ "artifact": "9c41f0…8d17", "bytes": 412736, "durationMs": 38213 }`,
    artifact: "9c41f0…8d17",
    bytes: "403 KiB",
    tier: "local",
    ladder: [
      { id: "1", label: "validateKey", note: "key1_ · 256 max", tone: "ok" },
      { id: "2", label: "validateFence", note: "recordedBy absent", tone: "muted" },
      { id: "3", label: "validateAge", note: "no maxAgeMs", tone: "muted" },
      { id: "4", label: "flows_step_cache", note: "1 row", tone: "ok" },
      { id: "5", label: "hit", note: "not executed", tone: "ok" }
    ]
  },
  {
    id: "test",
    verdict: "replay",
    tone: "info",
    keyDigest: "key1_0c4ab8…77f2",
    source: "flows_step_cache_recorded",
    createdAtMs: "1 758 142 061 907",
    recordedRunId: "run_2f10bc",
    recordedEventSeq: 141,
    canonical:
      `{"body":{"declaration":{"action":"vitest","project":"flows"},"version":"flows/key-material/v2"},"capabilities":{"declared":["fs:read:packages/**","proc:spawn:bun"]},"environment":{"capabilities":{},"declared":true,"layers":["NodeFileSystem"]},"hermetic":{"boundaryMode":"hard","readSet":[{"digest":"d208b7…61c4","path":"packages/smithers/flows/plan/test"}],"writeSet":[{"_tag":"Glob","include":["coverage/**"]}]},"inputs":{"0":{"digest":"key1_31b0f4…c9de","kind":"digest","reference":"ref"}},"kind":"content","layers":["NodeFileSystem"]}`,
    result: `{ "files": 214, "failed": 0, "passed": 1907 }`,
    meta: `{ "artifact": "51ba7d…e004", "bytes": 88112, "durationMs": 91440 }`,
    artifact: "51ba7d…e004",
    bytes: "86 KiB",
    tier: "local",
    ladder: [
      { id: "1", label: "validateKey", note: "key1_ · 256 max", tone: "ok" },
      { id: "2", label: "validateFence", note: "run_2f10bc · seq 141", tone: "ok" },
      { id: "3", label: "validateAge", note: "no maxAgeMs", tone: "muted" },
      { id: "4", label: "head moved", note: "evicted, ledger kept", tone: "warn" },
      { id: "5", label: "replay", note: "recorded bytes, not the world", tone: "info" }
    ]
  },
  {
    id: "build",
    verdict: "miss",
    tone: "warn",
    keyDigest: "key1_5b2077…ff41",
    source: "—",
    createdAtMs: "1 758 142 188 550",
    recordedRunId: "run_8ac431",
    recordedEventSeq: 96,
    canonical:
      `{"body":{"declaration":{"action":"build","target":"@smthrs/plan"},"version":"flows/key-material/v2"},"capabilities":{"declared":["fs:read:packages/**","fs:write:dist/**","proc:spawn:bun"]},"environment":{"capabilities":{},"declared":true,"layers":["NodeFileSystem"]},"hermetic":{"boundaryMode":"hard","readSet":[{"digest":"b309fa…d41c","path":"packages/smithers/flows/plan/src"}],"removes":["dist/**"],"writeSet":[{"_tag":"Glob","include":["dist/**"]}]},"inputs":{"0":{"digest":"key1_a71d03…5b6e","kind":"digest","reference":"ref"},"1":{"digest":"key1_0c4ab8…77f2","kind":"digest","reference":"ref"}},"kind":"content","layers":["@smthrs/build","NodeFileSystem"]}`,
    result: `{ "targets": 31, "bytes": 2841004 }`,
    meta: `{ "artifact": "b309fa…d41c", "bytes": 2841004, "durationMs": 38213 }`,
    artifact: "b309fa…d41c",
    bytes: "2.7 MiB",
    tier: "local",
    ladder: [
      { id: "1", label: "validateKey", note: "key1_ · 256 max", tone: "ok" },
      { id: "2", label: "flows_step_cache", note: "0 rows", tone: "bad" },
      { id: "3", label: "body rekeyed", note: "PlanDiff · build", tone: "warn" },
      { id: "4", label: "ran", note: "38 213 ms", tone: "info" },
      { id: "5", label: "put", note: "Inserted", tone: "ok" }
    ]
  },
  {
    id: "lint",
    verdict: "expired",
    tone: "warn",
    keyDigest: "key1_77ce10…b108",
    source: "head · refused by maxAgeMs",
    createdAtMs: "1 757 361 400 002",
    recordedRunId: "run_c04e77",
    recordedEventSeq: 34,
    canonical:
      `{"body":{"declaration":{"action":"eslint","project":"flows"},"version":"flows/key-material/v2"},"capabilities":{"declared":["fs:read:packages/**"]},"environment":{"capabilities":{},"declared":true,"layers":["NodeFileSystem"]},"hermetic":{"boundaryMode":"hard","readSet":[],"writeSet":[]},"inputs":{"0":{"digest":"key1_31b0f4…c9de","kind":"digest","reference":"ref"}},"kind":"content","layers":["NodeFileSystem"]}`,
    result: `{ "errors": 0, "warnings": 4 }`,
    meta: `{ "artifact": "2ad910…4f6b", "bytes": 1804, "durationMs": 6102 }`,
    artifact: "2ad910…4f6b",
    bytes: "1.8 KiB",
    tier: "local",
    ladder: [
      { id: "1", label: "validateKey", note: "key1_ · 256 max", tone: "ok" },
      { id: "2", label: "flows_step_cache", note: "1 row", tone: "ok" },
      { id: "3", label: "validateAge", note: "9 d > maxAgeMs 86 400 000", tone: "bad" },
      { id: "4", label: "row kept", note: "read policy, not a delete", tone: "muted" },
      { id: "5", label: "miss", note: "ran", tone: "warn" }
    ]
  },
  {
    id: "changelog",
    verdict: "conflict",
    tone: "bad",
    keyDigest: "key1_c41902…0a7d",
    source: "head",
    createdAtMs: "1 758 142 233 781",
    recordedRunId: "run_8ac431",
    recordedEventSeq: 154,
    canonical:
      `{"body":{"declaration":{"agent":"codex","task":"changelog"},"version":"flows/key-material/v2"},"capabilities":{"declared":["fs:write:CHANGELOG.md","net:post:api.openai.com"]},"environment":{"capabilities":{},"declared":true,"layers":["@smthrs/harness"]},"hermetic":{"boundaryMode":"expected","readSet":[],"writeSet":["CHANGELOG.md"]},"inputs":{"0":{"digest":"key1_77ce10…b108","kind":"digest","reference":"pending"}},"kind":"content","layers":["@smthrs/harness"]}`,
    result: `{ "entry": "### Fixed\\n- plan diff attribution" }`,
    meta: `{ "artifact": "7fe218…c930", "bytes": 612, "durationMs": 12004 }`,
    artifact: "7fe218…c930",
    bytes: "612 B",
    tier: "remote",
    ladder: [
      { id: "1", label: "validateKey", note: "key1_ · 256 max", tone: "ok" },
      { id: "2", label: "flows_step_cache", note: "1 row", tone: "ok" },
      { id: "3", label: "put", note: "Conflict", tone: "bad" },
      { id: "4", label: "head unchanged", note: "first writer kept", tone: "muted" },
      { id: "5", label: "flows.engine.cache-conflict", note: "seq 154", tone: "bad" }
    ]
  },
  {
    id: "publish",
    verdict: "uncacheable",
    tone: "muted",
    keyDigest: "key1_7d510f…0e07",
    source: "StepKey.ordinal",
    createdAtMs: "—",
    recordedRunId: "run_8ac431",
    recordedEventSeq: 203,
    canonical: `{"kind":"ordinal","ordinal":8,"runId":"run_8ac431","tier":"irreversible"}`,
    result: `{ "registry": "registry.npmjs.org", "version": "1.0.0-rc.4" }`,
    meta: `{ "durationMs": 4118 }`,
    artifact: "—",
    bytes: "—",
    tier: "—",
    ladder: [
      { id: "1", label: "material.kind", note: "irreversible", tone: "bad" },
      { id: "2", label: "fromKeyMaterial", note: "non_content_material", tone: "bad" },
      { id: "3", label: "StepKey.ordinal", note: "run-local", tone: "muted" },
      { id: "4", label: "cache skipped", note: "never cross-run", tone: "muted" },
      { id: "5", label: "ran", note: "4 118 ms", tone: "info" }
    ]
  }
]

const LOOKUPS = [
  { label: "hit", value: 412, display: "412", tone: "ok" as const },
  { label: "miss", value: 96, display: "96", tone: "warn" as const }
]

const PUTS = [
  { label: "inserted", value: 96, display: "96", tone: "info" as const },
  { label: "existing_same", value: 311, display: "311", tone: "ok" as const },
  { label: "conflict", value: 1, display: "1", tone: "bad" as const }
]

export const Pane = pane({
  id: "step-cache",
  title: "Step cache",
  summary: "Why a step did not run: the digest, the recorded result, the artifact",
  packages: ["@smthrs/step-cache", "@smthrs/artifacts", "@smthrs/keys"],
  render: (context) => <StepCacheBody {...context} />
})

function StepCacheBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const stepId = typeof props.stepId === "string" ? props.stepId : "test"
  const step = STEPS.find((entry) => entry.id === stepId)
  return (
    <Split
      left={
        <>
          <Section title="Steps">
            <Rail
              items={STEPS.map((entry) => ({ id: entry.id, label: entry.id, note: entry.verdict, tone: entry.tone }))}
              selected={stepId}
              onSelect={(id) => runCommandSet("stepId", id)}
            />
          </Section>
          <Section title="flows_step_cache_lookups">
            <Bars rows={LOOKUPS} />
          </Section>
          <Section title="flows_step_cache_puts">
            <Bars rows={PUTS} />
          </Section>
        </>
      }
      right={step === undefined ? <Empty>No step selected.</Empty> : (
        <>
          <Section title={step.id} right={<Badge tone={step.tone}>{step.verdict}</Badge>}>
            <Facts rows={[
              { label: "key_digest", value: step.keyDigest, mono: true },
              { label: "served from", value: step.source, mono: true },
              { label: "created_at_ms", value: step.createdAtMs, mono: true },
              { label: "recorded_run_id", value: step.recordedRunId, mono: true },
              { label: "recorded_event_seq", value: step.recordedEventSeq, mono: true }
            ]} />
          </Section>
          <Section title="Why it did not run">
            <Steps steps={step.ladder} />
          </Section>
          <Section title="Canonical" right="RFC 8785 · SHA-256">
            <Code label={step.keyDigest}>{step.canonical}</Code>
          </Section>
          <Section title="Recorded">
            <Code label="result_json">{step.result}</Code>
            <Code label="meta_json">{step.meta}</Code>
          </Section>
          <Section title="Artifact">
            <Table
              columns={[
                { key: "address", label: "Address", mono: true },
                { key: "bytes", label: "Bytes", mono: true, right: true },
                { key: "tier", label: "Tier" },
                { key: "missing", label: "findMissing", right: true }
              ]}
              rows={[{
                id: step.artifact,
                address: step.artifact,
                bytes: step.bytes,
                tier: step.tier,
                missing: step.tier === "remote" ? <Badge tone="warn">1 of 1</Badge> : <Badge tone="ok">0</Badge>
              }]}
              empty="No bytes."
            />
          </Section>
        </>
      )}
    />
  )
}
