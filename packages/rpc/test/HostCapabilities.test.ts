import { describe, expect, test } from "vitest"
import { RuntimeCapabilitySchema } from "../src/AppBootstrap.ts"
import { cloudCapabilities, localCapabilities } from "../src/HostCapabilities.ts"

const booleans = [false, true] as const

test("browser.read requires an explicitly configured pinned transport on either host", () => {
  const cloud = { identity: true, cloud: true, agent: true, checkout: false, terminal: false }
  const local = { identity: true, cloud: true, agent: true }
  expect(cloudCapabilities(cloud)).not.toContain("browser.read")
  expect(localCapabilities(local)).not.toContain("browser.read")
  expect(cloudCapabilities({ ...cloud, browser: true })).toContain("browser.read")
  expect(localCapabilities({ ...local, browser: true })).toContain("browser.read")
})

describe("cloudCapabilities (the Worker, host cloud)", () => {
  test("a fully configured Worker emits the four capabilities the Worker emits today, in its order", () => {
    expect(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "cloud", "billing.checkout"])
  })

  test("an unconfigured Worker emits nothing", () => {
    expect(cloudCapabilities({ identity: false, cloud: false, agent: false, checkout: false, terminal: false }))
      .toEqual([])
  })

  test("each flag gates only its own capability", () => {
    expect(cloudCapabilities({ identity: true, cloud: false, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "billing.checkout"])
    expect(cloudCapabilities({ identity: false, cloud: true, agent: false, checkout: false, terminal: false }))
      .toEqual(["cloud"])
  })

  test("cloud.terminal appears last and only when the relay is on", () => {
    expect(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }))
      .toEqual(["agent", "identity", "cloud", "billing.checkout", "cloud.terminal"])
    expect(cloudCapabilities({ identity: false, cloud: false, agent: false, checkout: false, terminal: true }))
      .toEqual(["cloud.terminal"])
  })

  test("the Worker never claims cloud.pat and every entry is a known capability", () => {
    for (const identity of booleans) {
      for (const cloud of booleans) {
        for (const agent of booleans) {
          for (const checkout of booleans) {
            for (const terminal of booleans) {
              const emitted = cloudCapabilities({ identity, cloud, agent, checkout, terminal })
              expect(emitted).not.toContain("cloud.pat")
              expect(emitted.includes("cloud.terminal")).toBe(terminal)
              expect(new Set(emitted).size).toBe(emitted.length)
              for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
            }
          }
        }
      }
    }
  })
})

describe("localCapabilities (the Bun server, host local)", () => {
  test("a hybrid launch emits what the Bun server emits today: both cloud doors and no local backend", () => {
    expect(localCapabilities({ agent: true, identity: true, cloud: true })).toEqual([
      "agent",
      "identity",
      "cloud",
      "cloud.terminal",
      "cloud.pat"
    ])
  })

  test("an offline launch emits nothing: the desktop app offers only what the web offers", () => {
    expect(localCapabilities({ agent: false, identity: false, cloud: false })).toEqual([])
  })

  test("the chat stub is an agent without identity or Smithers Cloud", () => {
    expect(localCapabilities({ agent: true, identity: false, cloud: false })).toEqual(["agent"])
  })

  test("no launch claims a local backend door: the local backend retired (apps/app/docs/LOCAL-BACKEND-RETIREMENT.md)", () => {
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const cloud of booleans) {
          for (const capability of localCapabilities({ agent, identity, cloud })) {
            expect(capability.startsWith("local.")).toBe(false)
          }
        }
      }
    }
  })

  test("the cloud doors ride the Smithers Cloud upstream: offline answers 501 on /api/cloud-auth and /api/cloud-ws", () => {
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const cloud of booleans) {
          const emitted = localCapabilities({ agent, identity, cloud })
          expect(emitted.includes("cloud")).toBe(cloud)
          expect(emitted.includes("cloud.terminal")).toBe(cloud)
          expect(emitted.includes("cloud.pat")).toBe(cloud)
          expect(new Set(emitted).size).toBe(emitted.length)
          for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
        }
      }
    }
  })
})
