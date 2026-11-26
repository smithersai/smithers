import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { REPOSITORY_GRANTEE, type ShareAccess } from "../src/features/branch/contract.ts"
import type { Role } from "./Actor.vibe"
import * as Access from "./branch/Access.vibe"
import * as Budget from "./branch/Budget.vibe"
import * as RegistryEgress from "./branch/RegistryEgress.vibe"
import { CI_OWNER } from "./flows/CiJobMachine.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("apps/mvp worker branch authorization, egress & budget policy fuzz invariants", () => {
  it("Access.accessOf, underPolicy, ceilingOf, canView & canEdit enforce non-escalation and guest isolation", async () => {
    const roleArb = Schema.NullOr(Schema.Literals(["admin", "maintainer", "member", "guest"]))
    const shareArb = Schema.NullOr(Schema.Literals(["view", "edit"]))
    const arb = Arbitrary.schema(
      Schema.Struct({
        signedIn: Schema.Boolean,
        role: roleArb,
        actorId: Schema.Literals(["alice", "bob", "carol"]),
        createdBy: Schema.NullOr(Schema.Literals(["alice", "bob"])),
        personGrant: shareArb,
        repoGrant: shareArb
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ signedIn, role, actorId, createdBy, personGrant, repoGrant }) =>
          Effect.sync(() => {
            const actor = signedIn
              ? Option.some({ subject: { kind: "person" as const, id: actorId }, role: role as Role | null })
              : Option.none()
            const grants: Access.Grants = {
              createdBy,
              person: personGrant as ShareAccess | null,
              repository: repoGrant as ShareAccess | null
            }
            const access = Access.accessOf(actor, grants)

            // Signed-out or role-less actors NEVER get access
            if (!signedIn || role === null) {
              if (access !== "none" || Access.canView(access) || Access.canEdit(access)) return false
              return true
            }

            // Guests NEVER get edit or owner, and NEVER get access from repository link alone
            if (role === "guest") {
              if (Access.ceilingOf(role) !== "view") return false
              if (access === "owner" || access === "edit" || Access.canEdit(access)) return false
              if (personGrant === null && access !== "none") return false
              if (personGrant !== null && access !== "view") return false
            }

            // Members+ who created the branch always get owner
            if (role !== "guest" && createdBy === actorId) {
              if (access !== "owner" || !Access.canView(access) || !Access.canEdit(access)) return false
            }

            // canEdit implies canView
            if (Access.canEdit(access) && !Access.canView(access)) return false

            // underPolicy agrees exactly with accessOf
            const grantMap: Record<string, ShareAccess> = {}
            if (personGrant !== null) grantMap[actorId] = personGrant as ShareAccess
            if (repoGrant !== null) grantMap[REPOSITORY_GRANTEE] = repoGrant as ShareAccess
            const viaPolicy = Access.underPolicy({ createdBy, grants: grantMap }, actorId, role as Role)
            if (viaPolicy !== access) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RegistryEgress & Budget isolate CI jobs from secrets egress and classify branch kinds/owners strictly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        branchId: Schema.Literals(["br-1", "overflow-abc", "ci-job-9", "todo-42"]),
        kind: Schema.Literals(["branch", "job"]),
        forge: Schema.Literals(["code-storage", "github"]),
        secretsOn: Schema.Boolean,
        ownerId: Schema.Literals(["", "alice", CI_OWNER]),
        caPath: Schema.Literals(["/etc/ssl/egress.pem", "/tmp/ca.crt"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ branchId, kind, forge, secretsOn, ownerId, caPath }) =>
          Effect.sync(() => {
            const branch = {
              branchId,
              kind,
              forge,
              repository: "smithersai/smithers",
              name: "main"
            } as unknown as Parameters<typeof Budget.kindOf>[0]

            // CI jobs must NEVER receive secrets egress, even when SANDBOX_SECRETS is enabled
            const usesSecrets = RegistryEgress.secretsEgress(branch, secretsOn)
            if (kind === "job" && usesSecrets) return false
            if (!secretsOn && usesSecrets) return false
            if (kind !== "job" && secretsOn && !usesSecrets) return false

            const trust = RegistryEgress.trustOf(caPath)
            if (trust.NODE_EXTRA_CA_CERTS !== caPath || trust.DPRINT_CERT !== caPath) return false
            if (RegistryEgress.POLICY.secrets.length !== 0 || RegistryEgress.POLICY.allow.length === 0) return false

            const k = Budget.kindOf(branch)
            if (kind === "job" && k !== "job") return false
            if (kind !== "job" && branchId.startsWith("overflow-") && k !== "overflow") return false
            if (kind !== "job" && !branchId.startsWith("overflow-") && forge === "github" && k !== "todo") return false

            const p = Budget.personOf(ownerId || undefined)
            if ((ownerId === "" || ownerId === CI_OWNER) && p !== null) return false
            if (ownerId === "alice" && p !== "alice") return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
