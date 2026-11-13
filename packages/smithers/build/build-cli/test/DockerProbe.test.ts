import { Effect } from "effect"
import { expect, it } from "vitest"
import { dockerAvailableEffect, DockerProbe } from "./helpers/DockerProbe.ts"

it("fails a stalled bounded native Docker probe instead of skipping its tests", () => {
  const error = Object.assign(new Error("Docker probe timed out"), { code: "ETIMEDOUT" })
  const attempts: Array<unknown> = []
  expect(() =>
    Effect.runSync(dockerAvailableEffect.pipe(
      Effect.provideService(DockerProbe, {
        probe: (command, args, options) => {
          attempts.push({ command, args, options })
          return Effect.succeed({ status: null, error })
        }
      })
    ))
  ).toThrow("Docker availability probe timed out after 5000ms")
  expect(attempts).toEqual([{
    command: "docker",
    args: ["info"],
    options: { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" }
  }])
})

it.each([0, 1, null])("reports Docker availability for status %s", (status) => {
  expect(Effect.runSync(dockerAvailableEffect.pipe(
    Effect.provideService(DockerProbe, { probe: () => Effect.succeed({ status }) })
  ))).toBe(status === 0)
})
