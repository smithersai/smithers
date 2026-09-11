/** Refuse a successful scheduled campaign without complete replayable evidence. */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { isMain } from "./workspace-packages.mjs"

export const verifySignalCampaign = async (directory, { seed, cases, steps }) => {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff || !Number.isSafeInteger(cases) || cases < 1 || !Number.isSafeInteger(steps) || steps < 1) throw new Error("Invalid signal campaign configuration")
  for (let index = 0; index < cases; index++) {
    const derivedSeed = (seed + Math.imul(index, 0x9e3779b9)) >>> 0
    const artifact = JSON.parse(await readFile(join(directory, `signal-inbox-${derivedSeed}.json`), "utf8"))
    if (artifact.status !== "passed" || artifact.seed !== derivedSeed || artifact.steps !== steps || !Array.isArray(artifact.history) || artifact.history.length < steps || !Array.isArray(artifact.finalState) || !Number.isInteger(artifact.reopenCount) || artifact.reopenCount < 1) throw new Error(`Incomplete signal campaign evidence for seed ${derivedSeed}`)
  }
  return { seed, cases, steps }
}

if (isMain(import.meta)) {
  if (!process.argv[2]) throw new Error("usage: node scripts/check-signal-campaign.mjs <artifact-directory>")
  const configuration = await verifySignalCampaign(process.argv[2], {
    seed: Number(process.env.SMITHERS_FUZZ_SEED),
    cases: Number(process.env.SMITHERS_FUZZ_CASES),
    steps: Number(process.env.SMITHERS_FUZZ_STEPS)
  })
  console.log(`Verified complete signal campaign evidence: ${JSON.stringify(configuration)}`)
}
