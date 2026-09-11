/**
 * `verifySignalCampaign` accepts only a complete, passing, correctly seeded
 * campaign.
 *
 * Run it with `node --test scripts/check-signal-campaign.test.mjs`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "node:test"
import { verifySignalCampaign } from "./check-signal-campaign.mjs"

it("campaign evidence refuses a missing case, truncated history, wrong seed and failed result", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "smithers-campaign-evidence-"))
  try {
    const first = { status: "passed", seed: 7, steps: 2, history: [{ kind: "reopen" }, { kind: "admit" }], reopenCount: 1, finalState: [] }
    const secondSeed = (7 + Math.imul(1, 0x9e3779b9)) >>> 0
    const second = { ...first, seed: secondSeed }
    const firstPath = join(temporary, "signal-inbox-7.json")
    const secondPath = join(temporary, `signal-inbox-${secondSeed}.json`)
    const configuration = { seed: 7, cases: 2, steps: 2 }
    writeFileSync(firstPath, JSON.stringify(first))
    await assert.rejects(verifySignalCampaign(temporary, configuration), /ENOENT/)
    writeFileSync(secondPath, JSON.stringify(second))
    assert.deepEqual(await verifySignalCampaign(temporary, configuration), configuration)
    for (const change of [{ history: [] }, { seed: 8 }, { status: "failed" }, { steps: 1 }, { reopenCount: 0 }]) {
      writeFileSync(firstPath, JSON.stringify({ ...first, ...change }))
      await assert.rejects(verifySignalCampaign(temporary, configuration), /Incomplete signal campaign evidence/)
    }
    await assert.rejects(verifySignalCampaign(temporary, { ...configuration, seed: 4294967296 }), /Invalid signal campaign configuration/)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
