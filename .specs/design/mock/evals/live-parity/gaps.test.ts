/**
 * Persisted scorer results distinguish complete evidence from incomplete data.
 *
 * @since 0.1.0
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderGaps, loadRun } from "./gaps.mjs"

const output = () => ({
  view: "issues", outcome: "compared", unobservable: [],
  pairs: [{ id: "issues-list-open", width: 1440, outcome: "compared" }]
})

const scoreNames = ["live-clean", "structure-parity", "parity-judge"] as const
const invalidScores = [{}, { score: null }, { score: "1" }, { score: true }, { score: -0.01 }, { score: 1.01 }, { score: NaN }, { score: Infinity }, null, [], 1, "1"]

test("gap reports never count absent or invalid numeric results as green", () => {
  for (const name of scoreNames) for (const invalid of invalidScores) {
    const scores: Record<string, unknown> = Object.fromEntries(scoreNames.map(key => [key, { score: 1 }]))
    scores[name] = invalid
    const markdown = renderGaps([{ output: output(), scores }])
    assert.match(markdown, /\| issues \| 1 \| inconclusive/, `${name}: ${JSON.stringify(invalid)}`)
    assert.match(markdown, /Increment 1: views 0 green/)
    assert.doesNotMatch(markdown, /None observed/)
  }
})

test("gaps loader classifies valid JSON with invalid results as inconclusive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-parity-"))
  try {
    await writeFile(join(dir, "issues.json"), JSON.stringify(output()))
    for (const name of scoreNames) await writeFile(join(dir, `issues.${name}.json`), JSON.stringify({ score: 1 }))
    for (const name of scoreNames) {
      for (const invalid of [...invalidScores, { score: 1, inconclusive: "judge unavailable" }]) {
        await writeFile(join(dir, `issues.${name}.json`), JSON.stringify(invalid))
        const markdown = renderGaps(await loadRun(dir))
        assert.match(markdown, /\| issues \| 1 \| inconclusive/, `${name}: ${JSON.stringify(invalid)}`)
        assert.match(markdown, /Increment 1: views 0 green/)
        assert.match(markdown, new RegExp(`Unobservable:.*${name}:`))
      }
      await writeFile(join(dir, `issues.${name}.json`), JSON.stringify({ score: 1 }))
    }
    const incomplete = { inconclusive: "judge unavailable", meta: { gaps: ["issues: needs a person"], unobservable: ["review unfinished"] } }
    await writeFile(join(dir, "issues.parity-judge.json"), JSON.stringify(incomplete))
    const records = await loadRun(dir)
    assert.deepEqual(records[0]!.scores["parity-judge"], incomplete)
    assert.match(renderGaps(records), /issues: needs a person/)
    assert.match(renderGaps(records), /review unfinished/)
    await writeFile(join(dir, "issues.parity-judge.json"), JSON.stringify({ score: 1 }))
    for (const score of [0, 0.5, 1]) {
      await writeFile(join(dir, "issues.live-clean.json"), JSON.stringify({ score }))
      assert.match(renderGaps(await loadRun(dir)), score === 1 ? /Increment 1: views 1 green/ : /Increment 1: views 0 green \/ 1 gaps/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

