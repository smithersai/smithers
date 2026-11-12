/** Refuse incomplete sync soak evidence. Scheduling a tier does not prove it ran. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { isMain } from "../../../../packages/repo-targets/scripts/workspace-packages.mjs"
import { verify } from "../../../../packages/smithers/flows/sync/test/soakArtifact.ts"

/**
 * What the schedule states about its receipt: `SMITHERS_SOAK_MINUTES`,
 * `SMITHERS_SOAK_SEED` and `SMITHERS_SOAK_NODE`, each checked when set.
 */
export function expectation(env) {
  return {
    minimumMinutes: env.SMITHERS_SOAK_MINUTES === undefined ? 1 : Number(env.SMITHERS_SOAK_MINUTES),
    ...(env.SMITHERS_SOAK_SEED === undefined ? {} : { seed: Number(env.SMITHERS_SOAK_SEED) }),
    ...(env.SMITHERS_SOAK_NODE === undefined ? {} : { node: env.SMITHERS_SOAK_NODE })
  }
}

if (isMain(import.meta)) {
  const path = process.argv[2]
  assert.ok(path, "usage: node .smithers/flows/bench/soak-campaign/check-soak-campaign.mjs <artifact.json>")
  const artifact = JSON.parse(readFileSync(path, "utf8"))
  verify(artifact, expectation(process.env))
  console.log(JSON.stringify({
    minutes: artifact.workload.requestedMinutes,
    seed: artifact.workload.seed,
    samples: artifact.samples.length,
    growth: artifact.slopes
  }))
}
