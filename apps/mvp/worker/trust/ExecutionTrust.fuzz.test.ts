import * as fc from "fast-check"
import { describe, expect, test } from "vitest"
import { isTrustedExecution, OBJECT_NAMESPACES, type ObjectNamespace } from "../../src/features/trust/contract.ts"
import type { Actor } from "../Actor.vibe"
import {
  authorizeObjectWrite,
  canSatisfyGate,
  canWriteTrustedCache,
  classifyExecutionTrust,
  mintTrustFor,
} from "./ExecutionTrust.vibe"

const POLICY = { admins: new Set(["roninjin10"]) }
const roleArb = fc.constantFrom<"admin" | "maintainer" | "member" | "guest" | null>("admin", "maintainer", "member", "guest", null)
const nonMaintainerRoleArb = fc.constantFrom<"member" | "guest" | null>("member", "guest", null)
const namespaceArb = fc.constantFrom<ObjectNamespace>(...OBJECT_NAMESPACES)
const loginArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$/)
const keyArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,40}$/).filter((k) => !k.includes(".."))

describe("ExecutionTrust property invariants (fast-check)", () => {
  test("untrusted contributors can NEVER gain trusted cache writes, merge gate eligibility, or trusted token minting", () => {
    fc.assert(
      fc.property(nonMaintainerRoleArb, (role) => {
        const trust = classifyExecutionTrust({
          role,
          isDeploymentAdmin: false,
          sandboxAttested: false,
        })
        expect(trust).toBe("untrusted_contributor")
        expect(isTrustedExecution(trust)).toBe(false)
        expect(canWriteTrustedCache(trust)).toBe(false)
        expect(canSatisfyGate(trust)).toBe(false)
        expect(mintTrustFor(trust, "sandbox")).toBe("untrusted_contributor")
        expect(mintTrustFor(trust, "agent")).toBe("untrusted_contributor")
        expect(mintTrustFor(trust, "ci")).toBe("untrusted_contributor")
      }),
      { numRuns: 100 },
    )
  })

  test("untrusted callers are ALWAYS refused cache and canonical mythical writes, and ALWAYS isolated for audit-report and wiki", () => {
    fc.assert(
      fc.property(nonMaintainerRoleArb, namespaceArb, keyArb, loginArb, (role, namespace, key, login) => {
        const trust = classifyExecutionTrust({
          role,
          isDeploymentAdmin: false,
          sandboxAttested: false,
        })
        const actor: Actor = { subject: { kind: "person", id: `p-${login}` }, role: role ?? "guest", login }
        const decision = authorizeObjectWrite({
          repoFullName: "smithersai/smithers",
          namespace,
          key,
          trust,
          actor,
          login,
          policy: POLICY,
        })
        if (namespace === "cache") {
          expect(decision.ok).toBe(false)
          if (!decision.ok) expect(decision.reason).toBe("untrusted_cache_write")
        } else if (namespace === "mythical") {
          expect(decision.ok).toBe(false)
          if (!decision.ok) expect(decision.reason).toBe("untrusted_mythical_write")
        } else if (namespace === "audit-report" || namespace === "artifact" || namespace === "changeset") {
          expect(decision.ok).toBe(true)
          if (decision.ok) {
            expect(decision.gateEligible).toBe(false)
            expect(decision.canonicalKey.startsWith(`untrusted/${login.toLowerCase()}/`)).toBe(true)
          }
        } else if (namespace === "wiki") {
          expect(decision.ok).toBe(true)
          if (decision.ok) {
            expect(decision.gateEligible).toBe(false)
            expect(decision.canonicalKey.startsWith(`proposed/${login.toLowerCase()}/`)).toBe(true)
          }
        } else {
          expect(decision.ok).toBe(true)
          if (decision.ok) {
            expect(decision.gateEligible).toBe(false)
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  test("Smithers-Ops ALWAYS refuses non-admin or agent-delegated writes regardless of namespace", () => {
    fc.assert(
      fc.property(namespaceArb, keyArb, loginArb, (namespace, key, login) => {
        const safeLogin = login.toLowerCase() === "roninjin10" ? "other-user" : login
        const nonAdmin: Actor = { subject: { kind: "person", id: `p-${safeLogin}` }, role: "maintainer", login: safeLogin }
        const agentOnAdmin: Actor = {
          subject: { kind: "person", id: "p-admin" },
          role: "admin",
          login: "roninjin10",
          act: { kind: "agent", id: "mcp:tok-1" },
        }
        const d1 = authorizeObjectWrite({
          repoFullName: "smithersai/Smithers-Ops",
          namespace,
          key,
          trust: "trusted_maintainer",
          actor: nonAdmin,
          login: safeLogin,
          policy: POLICY,
        })
        const d2 = authorizeObjectWrite({
          repoFullName: "smithersai/Smithers-Ops",
          namespace,
          key,
          trust: "trusted_maintainer",
          actor: agentOnAdmin,
          login: "roninjin10",
          policy: POLICY,
        })
        expect(d1.ok).toBe(false)
        expect(d2.ok).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  test("trusted sandboxes and maintainers always receive consistent gate and cache rights", () => {
    fc.assert(
      fc.property(roleArb, fc.boolean(), fc.boolean(), (role, isDeploymentAdmin, sandboxAttested) => {
        const trust = classifyExecutionTrust({ role, isDeploymentAdmin, sandboxAttested })
        const expectedTrusted = sandboxAttested || isDeploymentAdmin || role === "maintainer" || role === "admin"
        expect(isTrustedExecution(trust)).toBe(expectedTrusted)
        expect(canWriteTrustedCache(trust)).toBe(expectedTrusted)
        expect(canSatisfyGate(trust)).toBe(expectedTrusted)
      }),
      { numRuns: 100 },
    )
  })
})
