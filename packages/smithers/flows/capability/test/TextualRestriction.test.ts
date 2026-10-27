import { expect, test } from "vitest"
import { Capability, Permission } from "../src/index.ts"

test.each(["deny", "ask"] as const)("%s applies to either validated path form", (effect) => {
  const allow = new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "**" })
  })
  const restriction = new Permission.Rule({
    effect,
    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "src/secret/**" })
  })
  expect(Permission.evaluate([[allow, restriction]], Capability.make("fs:read", "src/secret/../x"))).toBe(effect)
  expect(Permission.evaluate([[allow, restriction]], Capability.make("fs:read", "src/x"))).toBe("allow")
  expect(Permission.evaluate([[restriction]], Capability.make("fs:write", "src/secret/../x"))).toBe("ask")
})
