import { expect, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { type Artifact, verify } from "./soakArtifact.ts"

// The scheduled tier is opt-in. The ordinary package gate retains the bounded
// ServerSoak tests and the artifact verifier tests and skips the timed soak.
const configured = process.env.SMITHERS_SOAK_MINUTES
const minutes = configured === undefined ? 0 : Number(configured)
if (configured !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > 720)) {
  throw new Error("SMITHERS_SOAK_MINUTES must be 1..720")
}
it.runIf(configured !== undefined)(
  "holds post-warmup growth slopes through TCP reconnects, compaction, retention and a stalled subscriber",
  async () => {
    const artifactPath = process.env.SMITHERS_SOAK_ARTIFACT
    if (!artifactPath) throw new Error("SMITHERS_SOAK_ARTIFACT is required")
    const child = spawn(process.execPath, [
      "--expose-gc",
      fileURLToPath(new URL("./fixtures/long-soak-child.ts", import.meta.url))
    ], {
      stdio: "inherit",
      env: process.env
    })
    const watchdog = setTimeout(() => child.kill("SIGTERM"), minutes * 60_000 + 20_000)
    const hardStop = setTimeout(() => child.kill("SIGKILL"), minutes * 60_000 + 25_000)
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }))
        child.once("error", reject)
      })
      expect(result).toEqual({ code: 0, signal: null })
      verify(JSON.parse(await readFile(artifactPath, "utf8")) as Artifact, minutes)
    } finally {
      clearTimeout(watchdog)
      clearTimeout(hardStop)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
  },
  minutes * 60_000 + 30_000
)
