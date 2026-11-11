/**
 * Behavioral projection contract checks for Settings.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { SettingsCardSchema } from "../../src/SettingsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Settings.ts"

cardContract("Settings", SettingsCardSchema, fixtures)

// Literal oracle: spec §4.4 sync health.
const SYNC_HEALTH = ["fresh", "stale", "limited", "refused"] as const
const ready = fixtures.ready.model

describe("Settings", () => {
  test("unknown GitHub rate headers remain absent while Settings health is readable", () => {
    const { rate_remaining, rate_limit, ...github } = ready.health.github
    const parsed = SettingsCardSchema.parse({ ...ready, health: { ...ready.health, github } })
    expect(parsed.health.github).not.toHaveProperty("rate_remaining")
    expect(parsed.health.github).not.toHaveProperty("rate_limit")
    expect(parsed.health.github.health).toBe("fresh")
  })

  test.each(["capacity", "parallel"] as const)("%s accepts zero and refuses negative or fractional", (field) => {
    for (const value of [0, 1, -1, 0.5]) {
      expect(SettingsCardSchema.safeParse({ ...ready, [field]: value }).success).toBe(value === 0 || value === 1)
    }
  })
  test("stories cover every GitHub sync health", () => {
    const health = Object.values(fixtures).map((story) => story.model.health.github.health)
    expect([...new Set(health)].sort()).toEqual([...SYNC_HEALTH].sort())
  })
  test.each(["ok", "rate_limited", "Fresh", ""])("refuses GitHub health %j", (health) => {
    const github = { ...ready.health.github, health }
    expect(SettingsCardSchema.safeParse({ ...ready, health: { ...ready.health, github } }).success).toBe(false)
  })
  test.each(["down", "OK", ""])("refuses process health %j", (process) => {
    expect(SettingsCardSchema.safeParse({ ...ready, health: { ...ready.health, process } }).success).toBe(false)
  })
  test("keeps the setup fields and adds the Settings ones", () => {
    const parsed = SettingsCardSchema.parse(ready)
    expect(parsed.steps).toHaveLength(7)
    expect(parsed.laptop_lines).toEqual([
      "smthrs login http://mac-mini.local:8080",
      "smthrs login https://smithers.example.test"
    ])
  })

  test("the Obsidian folder is optional and keeps its sync error", () => {
    expect(SettingsCardSchema.parse(ready).obsidian).toBeUndefined()
    expect(SettingsCardSchema.parse(fixtures.obsidian_error.model).obsidian).toEqual({
      path: "/Users/ben/Missing",
      error: "Folder not found"
    })
  })
})

describe("Settings daily TODO admissions (spec §10.4.1b)", () => {
  test("a projection may omit the allowance", () => {
    const { todo_daily_admissions: _omitted, ...withoutAllowance } = fixtures.ready.model
    expect(SettingsCardSchema.parse(withoutAllowance)).not.toHaveProperty("todo_daily_admissions")
  })
  test.each([1, 12, 100])("accepts %d", (value) => {
    expect(SettingsCardSchema.safeParse({ ...fixtures.ready.model, todo_daily_admissions: value }).success).toBe(true)
  })
  test.each([0, -1, 1.5, "12"])("rejects %j", (value) => {
    expect(SettingsCardSchema.safeParse({ ...fixtures.ready.model, todo_daily_admissions: value }).success).toBe(false)
  })
})

describe("Settings failed address apply", () => {
  test("keeps the working bind and typed failure transition", () => {
    const address = SettingsCardSchema.parse(fixtures.address_failed.model).address
    expect(address.bind).toBe("0.0.0.0:8080")
    expect(address.failed).toEqual({
      from: "0.0.0.0:8080",
      to: "0.0.0.0:9090",
      reason: { class: "infra", message: "Address already in use" }
    })
    expect(SettingsCardSchema.parse(ready).address).not.toHaveProperty("failed")
  })
  test.each(["Address already in use", { message: "Address already in use" }, { class: "infra" }])(
    "rejects an untyped or incomplete failure %j",
    (reason) => {
      const model = fixtures.address_failed.model
      expect(
        SettingsCardSchema.safeParse({
          ...model,
          address: { ...model.address, failed: { ...model.address.failed, reason } }
        }).success
      ).toBe(false)
    }
  )
  test.each(["localhost", "NETWORK", ""])("rejects listen mode %j after failure", (listen) => {
    const model = fixtures.address_failed.model
    expect(SettingsCardSchema.safeParse({ ...model, address: { ...model.address, listen } }).success).toBe(false)
  })
  test("inherits the capacity fix action", () => {
    expect(SettingsCardSchema.parse(fixtures.no_capacity.model).this_mac.limit!.fix).toEqual({
      tag: "settings",
      label: "Close apps to free 6 GB",
      args: { step: "machine" }
    })
  })
})
