import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect, test } from "vitest"
import * as DeploymentPolicy from "./DeploymentPolicy.vibe"

describe("DeploymentPolicy", () => {
  test("roninjin10 is the only deployment admin by default", () => {
    expect(DeploymentPolicy.isDeploymentAdmin("roninjin10")).toBe(true)
    expect(DeploymentPolicy.isDeploymentAdmin("RONINJIN10")).toBe(true)
    expect(DeploymentPolicy.isDeploymentAdmin("alice")).toBe(false)
    expect(DeploymentPolicy.isDeploymentAdmin(undefined)).toBe(false)
  })

  test("everyone else is contributor except on projects they own", () => {
    const smithersRepo = { owner: "smithersai", name: "smithers" }
    const aliceRepo = { owner: "alice", name: "my-project" }
    expect(DeploymentPolicy.effectiveRole("roninjin10", smithersRepo, "admin")).toBe("admin")
    expect(DeploymentPolicy.effectiveRole("roninjin10", "smithersai/smithers", "admin")).toBe("admin")
    expect(DeploymentPolicy.effectiveRole("roninjin10", aliceRepo, "member")).toBe("admin")
    expect(DeploymentPolicy.effectiveRole("alice", smithersRepo, "admin")).toBe("member")
    expect(DeploymentPolicy.effectiveRole("alice", "smithersai/smithers", "admin")).toBe("member")
    expect(DeploymentPolicy.effectiveRole("alice", smithersRepo, "maintainer")).toBe("member")
    expect(DeploymentPolicy.effectiveRole("alice", smithersRepo, "member")).toBe("member")
    expect(DeploymentPolicy.effectiveRole("alice", smithersRepo, "guest")).toBe("guest")
    expect(DeploymentPolicy.effectiveRole("alice", aliceRepo, "admin")).toBe("admin")
    expect(DeploymentPolicy.effectiveRole("alice", "alice/my-project", "admin")).toBe("admin")
    expect(DeploymentPolicy.isDeploymentAdmin("alice")).toBe(false)
  })

  test("requireDeploymentAdmin fails for non-admins", async () => {
    const ok = await Effect.runPromise(DeploymentPolicy.requireDeploymentAdmin({
      subject: { kind: "person", id: "p-1" },
      role: "admin",
      login: "roninjin10",
    }))
    const denied = await Effect.runPromise(Effect.exit(DeploymentPolicy.requireDeploymentAdmin({
      subject: { kind: "person", id: "p-2" },
      role: "admin",
      login: "alice",
    })))
    expect(ok).toBe("roninjin10")
    expect(Exit.isFailure(denied)).toBe(true)
  })
})
