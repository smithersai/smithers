import { Capability, decodePermissionError, Permission } from "@smthrs/capability"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Grant from "../examples/grant.vibe"
import * as Quickstart from "../examples/quickstart.ts"

describe("quickstart example", () => {
  it("allows covered requests and asks for the unmatched one", () => {
    expect(Quickstart.decide([
      Capability.make("fs:read", "/workspace/README.md"),
      Capability.make("proc:spawn", "npm install"),
      Capability.make("net:post", "https://api.example.test/deploy")
    ])).toEqual([
      ["fs:read:/workspace/README.md", "allow"],
      ["proc:spawn:npm install", "allow"],
      ["net:post:https://api.example.test/deploy", "ask"]
    ])
  })

  it("refuses configured text the grammar rejects", () => {
    expect(() => Quickstart.ruleFor("allow", "fs:read")).toThrow("Not a capability pattern: fs:read")
  })

  it("suspends an irreversible request with a failure a boundary can decode", () => {
    const { display, failure } = Quickstart.suspend(
      Capability.make("net:post", "https://api.example.test/deploy"),
      "req-1"
    )
    expect(display).toBe(
      "permission_required: net:post:https://api.example.test/deploy (tier irreversible, request req-1)"
    )
    expect(Capability.requiresIdempotencyKey(failure.tier)).toBe(true)
    const decoded = decodePermissionError(JSON.parse(JSON.stringify(failure)))
    expect(Option.map(decoded, Permission.formatError)).toEqual(Option.some(display))
  })

  it("keeps a configured deny final over a session allow", () => {
    const session = [Quickstart.ruleFor("allow", "fs:write:/workspace/.git/config")]
    expect(Quickstart.decideWithSession(session, Capability.make("fs:write", "/workspace/.git/config"))).toBe("deny")
    expect(Quickstart.decideWithSession(session, Capability.make("fs:read", "/workspace/.git/config"))).toBe("allow")
  })
})

describe("grant example", () => {
  it("grants exactly the approved command", () => {
    const request = Capability.make("proc:spawn", "npm install --offline")
    const grant = Option.getOrThrow(Grant.exactGrant(request))
    expect(Capability.matches(grant, request)).toBe(true)
    expect(Capability.matches(grant, Capability.make("proc:spawn", "npm install --offline --force"))).toBe(false)
  })

  it("refuses a directory whose text would widen the grant", () => {
    expect(Grant.subtreeGrant("/workspace/*")).toEqual(Option.none())
    const grant = Option.getOrThrow(Grant.subtreeGrant("/workspace/out"))
    expect(Capability.format(grant)).toBe("fs:write:/workspace/out/**")
    expect(Capability.matches(grant, Capability.make("fs:write", "/workspace/other"))).toBe(false)
  })

  it("proves coverage only for a recursive envelope", () => {
    const claim = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/src/a.ts" })
    expect(Grant.covers(new Capability.CapabilityPattern({ action: "fs:*", resource: "/workspace/**" }), claim)).toBe(
      true
    )
    expect(Grant.covers(new Capability.CapabilityPattern({ action: "fs:*", resource: "/workspace/*" }), claim)).toBe(
      false
    )
  })
})
