import { ConfigProvider, Effect } from "effect"
import { expect, test } from "vitest"
import * as Fleet from "./Fleet.ts"

const read = (values: Record<string, string>) => Effect.runPromise(Fleet.settings.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
))

test("fleet defaults, inclusive limits, optional spend cap and invalid bounds", async () => {
  expect(await read({})).toEqual(Fleet.DEFAULTS)
  expect(await read({ AGENT_STALL_MINUTES: "720", AGENT_WAIT_MINUTES: "1", RUNNER_OFFLINE_SECONDS: "3600", MAX_RUN_USD: "0.01" }))
    .toEqual({ stallMinutes: 720, waitMinutes: 1, offlineSeconds: 3600, maxRunUsd: 0.01 })
  expect(await read({ AGENT_STALL_MINUTES: "1", AGENT_WAIT_MINUTES: "720", RUNNER_OFFLINE_SECONDS: "45" }))
    .toMatchObject({ stallMinutes: 1, waitMinutes: 720, offlineSeconds: 45 })
  for (const [name, values] of Object.entries({ AGENT_STALL_MINUTES: ["0", "721"], AGENT_WAIT_MINUTES: ["0", "721"], RUNNER_OFFLINE_SECONDS: ["44", "3601"], MAX_RUN_USD: ["0", "-1"] })) {
    for (const value of values) await expect(read({ [name]: value })).rejects.toThrow(name)
  }
})
