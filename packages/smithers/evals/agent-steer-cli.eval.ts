// `npx vitest run --config evals/vitest.config.ts` with AGENT_STEER_PROFILES set: steering and stopping real external
// agents through a real `smthrs runner` (evals/agentSteerCli.ts). It runs real agents on the operator's accounts, so
// `pnpm test` never runs it, and it skips without a profiles file.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import * as AgentSteerCli from "./agentSteerCli.ts"

test.skipIf(process.env.AGENT_STEER_PROFILES === undefined)(
  "agent-steer-cli: every profile's agent takes a steer into its change, and Stop leaves none of its processes",
  async () => {
    const trials = await AgentSteerCli.run()
    const results = fileURLToPath(new URL("./results", import.meta.url))
    mkdirSync(results, { recursive: true })
    writeFileSync(join(results, `agent-steer-cli-${Date.now()}.json`), JSON.stringify(trials, null, 2))
    expect(trials.length).toBeGreaterThan(0)
    expect(trials.filter((trial) => !trial.pass)).toEqual([])
  },
  60 * 60_000
)
