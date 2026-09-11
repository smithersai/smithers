/**
 * Asserts a fixture scorecard against the numbers it was built from.
 *
 *   node fixtures/check.mjs <expect-latency|expect-no-latency>
 *
 * The fixture journal carries the 2026-08-19 wave's recorded numbers; the
 * scorecard must report exactly those, and must reach the same buckets the wave
 * reached against the committed codex baseline.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] ?? "expect-no-latency"
const read = (path) => JSON.parse(readFileSync(path, "utf8"))

const mirror = read(join(here, "mirror-results.json"))
const baseline = read(join(here, "..", "baseline", "codex-comparison.json"))
const card = read(join(here, "scorecard.json"))

const failures = []
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`)
}

const bucket = (flows, codex) =>
  flows === "resolved" && codex !== "resolved" ? "FLOWS WIN"
  : codex === "resolved" && flows !== "resolved" ? "codex win"
  : flows === "resolved" ? "both pass" : "both fail"

check("instance count", card.instances.length, mirror.length)
for (const expected of mirror) {
  const row = card.instances.find((instance) => instance.instanceId === expected.id)
  if (row === undefined) {
    failures.push(`${expected.id}: missing from the scorecard`)
    continue
  }
  const codex = baseline.find((entry) => entry.id === expected.id).codex
  check(`${expected.id} verdict`, row.quality.verdict, expected.graded)
  check(`${expected.id} patch bytes`, row.quality.patchBytes, expected.patchBytes)
  check(`${expected.id} edits attempted`, row.quality.editsAttempted, expected.edits)
  check(`${expected.id} edits succeeded`, row.quality.editsSucceeded, expected.editsOk)
  check(`${expected.id} turns`, row.speed.turns, expected.turns)
  check(`${expected.id} flow calls`, row.speed.flowCalls, expected.calls)
  check(`${expected.id} refusals`, row.speed.flowCallsRefused, expected.failed)
  check(`${expected.id} wall clock`, row.speed.wallClockSeconds, expected.seconds)
  check(`${expected.id} input tokens`, row.cost.inputTokens, expected.inTok)
  check(`${expected.id} output tokens`, row.cost.outputTokens, expected.outTok)
  check(`${expected.id} model`, row.cost.model, "openai:gpt-5.6-sol")
  check(`${expected.id} baseline verdict`, row.baseline?.verdict, codex.verdict)
  check(`${expected.id} bucket`, row.callout, bucket(expected.graded, codex.verdict))

  // Cost is the price table applied to the reported tokens, recomputed here.
  const expectedUsd = Math.round((expected.inTok * 5 + expected.outTok * 30) / 100) / 10_000
  check(`${expected.id} usd`, row.cost.usd, expectedUsd)

  if (mode === "expect-latency") {
    if (row.speed.meanCallLatencyMs === undefined) failures.push(`${expected.id}: expected a per-call latency`)
    check(`${expected.id} mean call latency`, row.speed.meanCallLatencyMs, Math.round(4000 + (expected.turns - 1) / 2))
    check(`${expected.id} latency availability`, row.speed.perCallLatency, "journaled")
  } else {
    if (row.speed.meanCallLatencyMs !== undefined) failures.push(`${expected.id}: expected no per-call latency`)
    if (!String(row.speed.perCallLatency).startsWith("unavailable")) {
      failures.push(`${expected.id}: expected the latency to be reported unavailable`)
    }
  }
}

// The preconditions block. A scorecard that cannot say which bytes a wave ran
// is not a scorecard, so the agreement rule is checked here rather than left to
// a reader noticing the line is missing.
const pinned = read(join(here, "subject.json"))
check("subject stamp", card.subject.stamp, pinned.stamp)
check("subject marker", card.subject.marker.hash, pinned.marker.hash)
check("subject agreement", card.subject.agreement, "one subject, pinned and stamped by every instance")
for (const expected of mirror) check(`${expected.id} subject`, card.subject.instances[expected.id], pinned.stamp)

// The rendered preconditions carry the paths the subject recorded, not the
// paths the repository uses today: a later layout change must not rewrite an
// old measurement's provenance.
const rendered = readFileSync(join(here, "scorecard.md"), "utf8")
for (const row of [
  `| \`${pinned.marker.path}\` | \`${pinned.marker.hash}\` |`,
  `| loaded from | ${pinned.marker.resolvedBy} |`,
  `| \`${pinned.cliDist.directory}\` | \`${pinned.cliDist.hash}\` (${pinned.cliDist.files} modules) |`,
  `| \`${pinned.cliSrc.directory}\` | \`${pinned.cliSrc.hash}\` (${pinned.cliSrc.files} files, built above) |`
]) {
  if (!rendered.includes(row)) failures.push(`scorecard.md: missing the recorded subject row ${row}`)
}

check("flows resolved", card.aggregate.flowsResolved, mirror.filter((row) => row.graded === "resolved").length)
check("codex resolved", card.aggregate.codexResolved, baseline.filter((row) => row.codex.verdict === "resolved").length)
check("flows wall clock total", card.aggregate.flowsWallClockSeconds, mirror.reduce((total, row) => total + row.seconds, 0))
check("codex wall clock total", card.aggregate.codexWallClockSeconds, baseline.reduce((total, row) => total + row.codex.seconds, 0))

if (failures.length > 0) {
  console.error(`check.mjs: ${failures.length} mismatch(es)`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`check.mjs: scorecard matches the recorded wave (${mode})`)
