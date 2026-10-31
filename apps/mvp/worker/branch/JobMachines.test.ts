// The job machines a deployment declares (worker/branch/JobMachines.ts, docs/features/ci.md#machines), read from its
// configuration as ChatApi and the flow host read them.
import { ConfigProvider, Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import * as JobMachines from "./JobMachines.ts"

const read = <A, E>(effect: Effect.Effect<A, E>, env: Record<string, string>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))))

describe("declared", () => {
  test("the gate is declared exactly when GATE_IMAGE names an image", async () => {
    const image = "registry.cloudflare.com/acct/smithers-gate@sha256:" + "0".repeat(64)
    expect(await read(JobMachines.declared, { GATE_IMAGE: image })).toEqual(Exit.succeed(["gate"]))
    expect(await read(JobMachines.declared, {})).toEqual(Exit.succeed([]))
    expect(await read(JobMachines.declared, { GATE_IMAGE: "  " })).toEqual(Exit.succeed([]))
  })

  test("the default machine is always declared; a job machine only when the deployment declares it", () => {
    expect(JobMachines.isDeclared([], undefined)).toBe(true)
    expect(JobMachines.isDeclared(["gate"], "gate")).toBe(true)
    expect(JobMachines.isDeclared([], "gate")).toBe(false)
    expect(JobMachines.isDeclared(["gate"], "gpu")).toBe(false)
  })
})

describe("gateInstance", () => {
  test("standard-4 unless GATE_INSTANCE names another instance type; anything else is refused", async () => {
    expect(await read(JobMachines.gateInstance, {})).toEqual(Exit.succeed("standard-4"))
    expect(await read(JobMachines.gateInstance, { GATE_INSTANCE: "standard-2" })).toEqual(Exit.succeed("standard-2"))
    expect(Exit.isFailure(await read(JobMachines.gateInstance, { GATE_INSTANCE: "huge" }))).toBe(true)
  })
})
