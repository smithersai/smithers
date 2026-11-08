import { Equal, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern } from "../src/Capability.ts"
import {
  fromPlatformError,
  GrantStoreError,
  PermissionDenied,
  PermissionRequired,
  Rule,
  toPlatformError
} from "../src/Permission.ts"

const capability = new Capability({ action: "fs:read", resource: "/a" })
const pattern = new CapabilityPattern({ action: "fs:*", resource: "/workspace/**" })

describe("capability journal golden vectors", () => {
  it("pins the encoded shape of every journaled capability schema", () => {
    const capabilityPayload = { action: "fs:read", resource: "/a" }
    expect(Schema.encodeUnknownSync(Capability)(capability)).toEqual(capabilityPayload)
    expect(Equal.equals(Schema.decodeUnknownSync(Capability)(capabilityPayload), capability)).toBe(true)

    const patternPayload = { action: "fs:*", resource: "/workspace/**" }
    expect(Schema.encodeUnknownSync(CapabilityPattern)(pattern)).toEqual(patternPayload)
    expect(Equal.equals(Schema.decodeUnknownSync(CapabilityPattern)(patternPayload), pattern)).toBe(true)

    const rule = new Rule({ effect: "allow", pattern })
    const rulePayload = { effect: "allow", pattern: patternPayload }
    expect(Schema.encodeUnknownSync(Rule)(rule)).toEqual(rulePayload)
    expect(Equal.equals(Schema.decodeUnknownSync(Rule)(rulePayload), rule)).toBe(true)

    const required = PermissionRequired.new({
      requestId: "r1",
      runId: "run1",
      capability,
      tier: "sealed",
      meta: { k: 1 }
    })
    const requiredPayload = {
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      runId: "run1",
      capability: capabilityPayload,
      tier: "sealed",
      meta: { k: 1 }
    }
    expect(Schema.encodeUnknownSync(PermissionRequired)(required)).toEqual(requiredPayload)
    expect(Equal.equals(Schema.decodeUnknownSync(PermissionRequired)(requiredPayload), required)).toBe(true)

    const denied = PermissionDenied.new({ capability, reason: "configured policy" })
    const deniedPayload = {
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: capabilityPayload,
      reason: "configured policy"
    }
    expect(Schema.encodeUnknownSync(PermissionDenied)(denied)).toEqual(deniedPayload)
    expect(Equal.equals(Schema.decodeUnknownSync(PermissionDenied)(deniedPayload), denied)).toBe(true)

    const store = new GrantStoreError({ code: "journal_failed", message: "disk full" })
    const storePayload = {
      _tag: "@smthrs/capability/GrantStoreError",
      code: "journal_failed",
      message: "disk full"
    }
    expect(Schema.encodeUnknownSync(GrantStoreError)(store)).toEqual(storePayload)
    expect(Equal.equals(Schema.decodeUnknownSync(GrantStoreError)(storePayload), store)).toBe(true)
  })

  it("pins the flat Rule schema identifier", () => {
    expect(Rule.ast.annotations).toMatchObject({ identifier: "@smthrs/capability/Rule" })
  })

  it("round trips an attended permission request through PlatformError", () => {
    const required = PermissionRequired.new({
      requestId: "r1",
      capability,
      tier: "sealed",
      meta: {}
    })
    const projected = toPlatformError({ module: "FileSystem", method: "readFile", error: required })
    const recovered = Option.getOrThrow(fromPlatformError(projected))

    expect(recovered).toBe(required)
    expect(recovered).toMatchObject({ requestId: "r1", tier: "sealed", capability })
  })
})
