import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Scores from "../src/migrations/0001_scores.ts"
import { migration as scores } from "../src/migrations/0001_scores.ts"
import * as ScoreJobs from "../src/migrations/0002_score_jobs.ts"
import { migration as jobs } from "../src/migrations/0002_score_jobs.ts"
import * as ScoreFailureCodes from "../src/migrations/0003_score_failure_codes.ts"
import { migration as failureCodes } from "../src/migrations/0003_score_failure_codes.ts"
import * as RequireFailureCodes from "../src/migrations/0004_require_failure_codes.ts"
import { migration as requiredFailureCodes } from "../src/migrations/0004_require_failure_codes.ts"
import * as RestartScoreIds from "../src/migrations/0005_restart_score_ids.ts"
import { migration as restartedScoreIds } from "../src/migrations/0005_restart_score_ids.ts"

// `scripts/build.mjs` converts every module to CommonJS with esbuild under
// `"type": "module"`, and esbuild then reads a default import of a sibling as
// the whole interop wrapper `{ __esModule, default }` rather than the value.
// `src/Migrations.ts` used to build its record from default imports,
// so `Migrations.run` in `dist/cjs` held wrappers, none with `pipe`.
// The named binding below is the one consumers import; the second test pins
// that no module offers a default export to regress onto.
const modules = {
  "0001_scores": { namespace: Scores, migration: scores },
  "0002_score_jobs": { namespace: ScoreJobs, migration: jobs },
  "0003_score_failure_codes": { namespace: ScoreFailureCodes, migration: failureCodes },
  "0004_require_failure_codes": { namespace: RequireFailureCodes, migration: requiredFailureCodes },
  "0005_restart_score_ids": { namespace: RestartScoreIds, migration: restartedScoreIds }
} as const

describe("migration modules", () => {
  it("exports every migration as the named Effect binding consumers import", () => {
    for (const [key, { migration }] of Object.entries(modules)) {
      expect(Effect.isEffect(migration), key).toBe(true)
      expect(typeof migration.pipe, key).toBe("function")
    }
  })

  it("offers no default export for a CommonJS importer to regress onto", () => {
    for (const [key, { namespace }] of Object.entries(modules)) {
      expect("default" in namespace, key).toBe(false)
      expect(Object.keys(namespace), key).toEqual(["migration"])
    }
  })
})
