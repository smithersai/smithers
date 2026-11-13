import { describe, expect, it } from "vitest"
import { PendingSnapshot } from "../src/index.ts"

const storage = (): PendingSnapshot.Storage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  }
}

describe("PendingSnapshot", () => {
  it("recovers an unacknowledged input after reload and fences late receipts", () => {
    const host = storage()
    const first = PendingSnapshot.make(host, "tab-a")
    expect(first.read()).toBeUndefined()
    const old = first.stage({ request: "first" })!
    const latest = first.stage({ request: "latest" })!
    first.acknowledge(old)
    const reloaded = PendingSnapshot.make(host, "tab-a")
    expect(reloaded.read()).toEqual({ token: latest, value: { request: "latest" } })
    expect(PendingSnapshot.make(host, "tab-b").read()).toBeUndefined()
    reloaded.acknowledge(latest)
    expect(first.read()).toBeUndefined()
    first.stage({ request: "signed out" })
    first.clear()
    expect(reloaded.read()).toBeUndefined()
  })

  it("keeps refused or unreadable storage out of the input callback", () => {
    const refused = () => {
      throw new Error("storage refused")
    }
    const service = PendingSnapshot.make({ getItem: refused, setItem: refused, removeItem: refused }, "tab")
    expect(service.stage("text")).toBeUndefined()
    expect(service.read()).toBeUndefined()
    expect(() => service.acknowledge("text")).not.toThrow()
    expect(() => service.clear()).not.toThrow()
    const host = storage()
    host.setItem("tab", "broken JSON")
    expect(PendingSnapshot.make(host, "tab").read()).toBeUndefined()
    const partial = PendingSnapshot.make({ ...host, removeItem: refused }, "tab")
    const token = partial.stage("text")!
    expect(() => partial.acknowledge(token)).not.toThrow()
    expect(partial.read()?.value).toBe("text")
    expect(partial.stage(undefined)).toBeUndefined()
    const cyclic: any = {}
    cyclic.self = cyclic
    expect(partial.stage(cyclic)).toBeUndefined()
  })
})

describe("owner-scoped PendingSnapshot", () => {
  it("never restores an unverified or different owner's pending input", () => {
    const host = storage()
    let owner: string | undefined
    const service = PendingSnapshot.make(host, "tab", () => owner)
    expect(service.stage("unverified")).toBeUndefined()
    owner = "first"
    const first = service.stage("first input")!
    expect(service.read()?.value).toBe("first input")
    owner = undefined
    expect(service.read()).toBeUndefined()
    owner = "second"
    expect(service.read()).toBeUndefined()
    service.stage("second input")
    service.acknowledge(first)
    expect(service.read()?.value).toBe("second input")
    for (const value of [null, 1, {}, { owner: "second" }, { owner: "other", value: "private" }]) {
      host.setItem("tab", JSON.stringify(value))
      expect(service.read()).toBeUndefined()
    }
  })
})

describe.each([false, true])("PendingSnapshot receipts (owner-scoped: %s)", (scoped) => {
  const owner = scoped ? () => "person" : undefined

  it("keeps the latest equal input through older receipts and reloads", () => {
    const host = storage()
    const firstService = PendingSnapshot.make(host, "tab", owner)
    const first = firstService.stage({ text: "a" })!
    const middle = firstService.stage({ text: "ab" })!
    const reloaded = PendingSnapshot.make(host, "tab", owner)
    const latest = reloaded.stage({ text: "a" })!

    firstService.acknowledge(first)
    expect(reloaded.read()).toEqual({ token: latest, value: { text: "a" } })
    firstService.acknowledge(middle)
    expect(reloaded.read()).toEqual({ token: latest, value: { text: "a" } })
    expect(new Set([first, middle, latest]).size).toBe(3)
    reloaded.acknowledge(latest)
    expect(firstService.read()).toBeUndefined()
  })

  it.each([null, false, 0, "", ["a"], { text: "a" }].map((value) => ({ value })))(
    "distinguishes consecutive equal stagings of $value",
    ({ value }) => {
      const host = storage()
      const firstService = PendingSnapshot.make(host, "tab", owner)
      const first = firstService.stage(value)!
      const reloaded = PendingSnapshot.make(host, "tab", owner)
      const latest = reloaded.stage(value)!
      firstService.acknowledge(first)
      expect(reloaded.read()).toEqual({ token: latest, value })
      expect(latest).not.toBe(first)
      reloaded.acknowledge(latest)
      expect(firstService.read()).toBeUndefined()
    }
  )

  it("restores and acknowledges snapshots written before versioned receipts", () => {
    const host = storage()
    const value = { text: "a" }
    const legacy = JSON.stringify(scoped ? { owner: "person", value } : value)
    host.setItem("tab", legacy)
    const service = PendingSnapshot.make(host, "tab", owner)
    expect(service.read()).toEqual({ token: legacy, value })
    service.acknowledge(legacy)
    expect(service.read()).toBeUndefined()

    host.setItem("tab", legacy)
    const latest = service.stage(value)!
    service.acknowledge(legacy)
    expect(service.read()).toEqual({ token: latest, value })
  })

  it("serializes the value once with its original JSON key", () => {
    const keys: Array<string> = []
    const value = {
      toJSON: (key: string) => {
        keys.push(key)
        return { text: "a" }
      }
    }
    const service = PendingSnapshot.make(storage(), "tab", owner)
    const token = service.stage(value)!
    expect(keys).toEqual([scoped ? "value" : ""])
    expect(service.read()).toEqual({ token, value: { text: "a" } })
  })
})

describe("PendingSnapshot storage format", () => {
  it.each([null, 1, "text", { receipt: "existing", value: "input" }, { owner: "existing", value: "input" }])(
    "preserves legacy unscoped JSON %j",
    (value) => {
      const host = storage()
      const token = JSON.stringify(value)
      host.setItem("tab", token)
      expect(PendingSnapshot.make(host, "tab").read()).toEqual({ token, value })
    }
  )

  it.each(["v1:missing-json", "v1:receipt:broken JSON"])("ignores malformed versioned storage %s", (value) => {
    const host = storage()
    host.setItem("tab", value)
    expect(PendingSnapshot.make(host, "tab").read()).toBeUndefined()
  })
})
