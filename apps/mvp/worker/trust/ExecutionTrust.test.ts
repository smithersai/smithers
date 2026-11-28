import { describe, expect, it } from "vitest"
import { isTrustedExecution, trustLabel } from "../../src/features/trust/contract.ts"
import type { Actor } from "../Actor.vibe"
import {
  auditReportTrust,
  authorizeObjectWrite,
  canReadCloudObject,
  canSatisfyGate,
  canWriteTrustedCache,
  changesetGateStatus,
  classifyExecutionTrust,
  isObjectNamespace,
  isValidObjectKey,
  mintTrustFor,
  resolveObjectVisibility,
  safeLoginSegment,
} from "./ExecutionTrust.vibe"

const adminActor: Actor = { subject: { kind: "person", id: "p-admin" }, role: "admin", login: "roninjin10" }
const memberActor: Actor = { subject: { kind: "person", id: "p-member" }, role: "member", login: "alice" }
const guestActor: Actor = { subject: { kind: "person", id: "p-guest" }, role: "guest", login: "bob" }
const agentActor: Actor = {
  subject: { kind: "person", id: "p-admin" },
  role: "admin",
  login: "roninjin10",
  act: { kind: "agent", id: "mcp:tok-1" },
}
const policy = { admins: new Set(["roninjin10"]) }

describe("ExecutionTrust", () => {
  it("retains community provenance when a maintainer or sandbox imports an audit", () => {
    const preview = { trusted: false, effectiveTier: "untrusted:community" }
    for (const publisher of ["trusted_maintainer", "trusted_sandbox", "untrusted_contributor"] as const) {
      for (const report of [
        { execution: preview },
        { execution: { trusted: false, effectiveTier: "trusted:maintainer" } },
        { execution: { effectiveTier: "untrusted:community" } },
        { execution: null, gate: { trustTier: "untrusted:community" } },
      ]) {
        expect(auditReportTrust(publisher, report)).toBe("untrusted_contributor")
      }
      expect(auditReportTrust(publisher, { execution: { trusted: true } })).toBe(publisher)
      expect(auditReportTrust(publisher, { gate: { satisfied: false } })).toBe(publisher)
      expect(auditReportTrust(publisher, {})).toBe(publisher)
    }
  })

  it("classifies sandbox attestation above everything, then maintainer/admin, else untrusted contributor", () => {
    expect(classifyExecutionTrust({ role: "guest", sandboxAttested: true })).toBe("trusted_sandbox")
    expect(classifyExecutionTrust({ role: "maintainer" })).toBe("trusted_maintainer")
    expect(classifyExecutionTrust({ role: "admin" })).toBe("trusted_maintainer")
    expect(classifyExecutionTrust({ role: null, isDeploymentAdmin: true })).toBe("trusted_maintainer")
    expect(classifyExecutionTrust({ role: "member" })).toBe("untrusted_contributor")
    expect(classifyExecutionTrust({ role: "guest" })).toBe("untrusted_contributor")
    expect(classifyExecutionTrust({ role: null })).toBe("untrusted_contributor")
  })

  it("never lets untrusted callers mint trusted sandbox or maintainer tokens", () => {
    expect(mintTrustFor("untrusted_contributor", "sandbox")).toBe("untrusted_contributor")
    expect(mintTrustFor("untrusted_contributor", "agent")).toBe("untrusted_contributor")
    expect(mintTrustFor("untrusted_contributor", "ci")).toBe("untrusted_contributor")
    expect(mintTrustFor("trusted_maintainer", "sandbox")).toBe("trusted_sandbox")
    expect(mintTrustFor("trusted_maintainer", "agent")).toBe("trusted_maintainer")
    expect(mintTrustFor("trusted_sandbox", "ci")).toBe("trusted_maintainer")
  })

  it("enforces cache write and gate eligibility strictly for trusted executions", () => {
    expect(canSatisfyGate("trusted_sandbox")).toBe(true)
    expect(canSatisfyGate("trusted_maintainer")).toBe(true)
    expect(canSatisfyGate("untrusted_contributor")).toBe(false)
    expect(canWriteTrustedCache("trusted_sandbox")).toBe(true)
    expect(canWriteTrustedCache("trusted_maintainer")).toBe(true)
    expect(canWriteTrustedCache("untrusted_contributor")).toBe(false)
    expect(isTrustedExecution("trusted_sandbox")).toBe(true)
    expect(isTrustedExecution("untrusted_contributor")).toBe(false)
    expect(trustLabel("trusted_sandbox")).toBe("Trusted sandbox")
    expect(trustLabel("trusted_maintainer")).toBe("Trusted maintainer")
    expect(trustLabel("untrusted_contributor")).toBe("Untrusted community run")
  })

  it("validates namespaces, object keys, and login segments strictly", () => {
    expect(isObjectNamespace("cache")).toBe(true)
    expect(isObjectNamespace("audit-report")).toBe(true)
    expect(isObjectNamespace("evil")).toBe(false)
    expect(isValidObjectKey("latest.json")).toBe(true)
    expect(isValidObjectKey("runs/abc123/report.json")).toBe(true)
    expect(isValidObjectKey("")).toBe(false)
    expect(isValidObjectKey("../escape")).toBe(false)
    expect(isValidObjectKey("/leading")).toBe(false)
    expect(isValidObjectKey("trailing/")).toBe(false)
    expect(isValidObjectKey("a\\b")).toBe(false)
    expect(isValidObjectKey("a/b/c/d/e/f/g")).toBe(false)
    expect(isValidObjectKey("bad key")).toBe(false)
    expect(safeLoginSegment("Bob-Dev")).toBe("bob-dev")
    expect(safeLoginSegment("../root")).toBe("anonymous")
    expect(safeLoginSegment(undefined)).toBe("anonymous")
  })

  it("blocks untrusted cache and mythical writes while isolating untrusted audit reports and wiki proposals", () => {
    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "cache",
      key: "target/sha256.tar.zst",
      trust: "untrusted_contributor",
      actor: guestActor,
      login: "bob",
      policy,
    })).toEqual({ ok: false, reason: "untrusted_cache_write" })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "mythical",
      key: "stack.json",
      trust: "untrusted_contributor",
      actor: guestActor,
      login: "bob",
      policy,
    })).toEqual({ ok: false, reason: "untrusted_mythical_write" })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "audit-report",
      key: "latest.json",
      trust: "untrusted_contributor",
      actor: guestActor,
      login: "Bob",
      policy,
    })).toEqual({
      ok: true,
      namespace: "audit-report",
      canonicalKey: "untrusted/bob/latest.json",
      gateEligible: false,
    })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "wiki",
      key: "architecture.md",
      trust: "untrusted_contributor",
      actor: guestActor,
      login: "bob",
      policy,
    })).toEqual({
      ok: true,
      namespace: "wiki",
      canonicalKey: "proposed/bob/architecture.md",
      gateEligible: false,
    })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "audit-report",
      key: "latest.json",
      trust: "trusted_sandbox",
      actor: adminActor,
      login: "roninjin10",
      policy,
    })).toEqual({
      ok: true,
      namespace: "audit-report",
      canonicalKey: "latest.json",
      gateEligible: true,
    })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "cache",
      key: "target/key.json",
      trust: "trusted_maintainer",
      actor: adminActor,
      login: "roninjin10",
      policy,
    })).toEqual({
      ok: true,
      namespace: "cache",
      canonicalKey: "target/key.json",
      gateEligible: false,
    })
  })

  it("locks ops repositories strictly to deployment admins acting in person", () => {
    expect(authorizeObjectWrite({
      repoFullName: "smithersai/Smithers-Ops",
      namespace: "artifact",
      key: "note.md",
      trust: "trusted_maintainer",
      actor: agentActor,
      login: "roninjin10",
      policy,
    })).toEqual({ ok: false, reason: "ops_repo_forbidden" })

    expect(authorizeObjectWrite({
      repoFullName: "smithersai/Smithers-Ops",
      namespace: "artifact",
      key: "note.md",
      trust: "trusted_maintainer",
      actor: adminActor,
      login: "roninjin10",
      policy,
    })).toEqual({ ok: true, namespace: "artifact", canonicalKey: "note.md", gateEligible: false })

    expect(resolveObjectVisibility({
      repoFullName: "smithersai/Smithers-Ops",
      isPublicRepo: true,
      namespace: "audit-report",
      requested: "public",
      policy,
    })).toBe("owner_only")

    expect(canReadCloudObject({
      repoFullName: "smithersai/Smithers-Ops",
      isPublicRepo: true,
      visibility: "public",
      createdByPersonId: "p-admin",
      actor: agentActor,
      role: "admin",
      policy,
    })).toBe(false)

    expect(canReadCloudObject({
      repoFullName: "smithersai/Smithers-Ops",
      isPublicRepo: false,
      visibility: "owner_only",
      createdByPersonId: "p-admin",
      actor: adminActor,
      role: "admin",
      policy,
    })).toBe(true)
  })

  it("resolves visibility and read permissions for public and private repos and maps changeset gate status", () => {
    expect(resolveObjectVisibility({
      repoFullName: "smithersai/smithers",
      isPublicRepo: true,
      namespace: "audit-report",
      policy,
    })).toBe("public")
    expect(resolveObjectVisibility({
      repoFullName: "smithersai/smithers",
      isPublicRepo: true,
      namespace: "artifact",
      policy,
    })).toBe("repo_members")
    expect(resolveObjectVisibility({
      repoFullName: "smithersai/private",
      isPublicRepo: false,
      namespace: "audit-report",
      requested: "public",
      policy,
    })).toBe("repo_members")

    expect(canReadCloudObject({
      repoFullName: "smithersai/smithers",
      isPublicRepo: true,
      visibility: "public",
      createdByPersonId: null,
      actor: undefined,
      role: null,
      policy,
    })).toBe(true)
    expect(canReadCloudObject({
      repoFullName: "smithersai/private",
      isPublicRepo: false,
      visibility: "repo_members",
      createdByPersonId: "p-member",
      actor: memberActor,
      role: "member",
      policy,
    })).toBe(true)
    expect(canReadCloudObject({
      repoFullName: "smithersai/private",
      isPublicRepo: false,
      visibility: "repo_members",
      createdByPersonId: "p-member",
      actor: guestActor,
      role: "guest",
      policy,
    })).toBe(false)

    expect(changesetGateStatus("trusted_sandbox", true)).toBe("passed")
    expect(changesetGateStatus("trusted_maintainer", false)).toBe("failed")
    expect(changesetGateStatus("untrusted_contributor", true)).toBe("untrusted_only")
    expect(changesetGateStatus("trusted_sandbox", null)).toBe("pending")
  })
})
