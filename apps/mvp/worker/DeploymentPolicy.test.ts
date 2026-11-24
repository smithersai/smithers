import { ConfigProvider, Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"
import type { Actor } from "./Actor.ts"
import * as DeploymentPolicy from "./DeploymentPolicy.vibe"

const configured = (env: Record<string, string>) =>
  Effect.runPromise(
    DeploymentPolicy.configuredAdmins().pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
    ),
  )

const person = (login: string): Actor => ({ subject: { kind: "person", id: `p-${login}` }, role: "admin", login })

describe("DeploymentPolicy", () => {
  // R1-Astra-D4-004, R1-NEON-D4-001: no account is built in.
  test("an installation that names no deployment admin has none", async () => {
    const unset: ReadonlyArray<Record<string, string>> = [{}, { DEPLOYMENT_ADMIN_LOGINS: "" }, { DEPLOYMENT_ADMIN_LOGINS: "  , ,  " }]
    for (const env of unset) {
      const admins = await configured(env)
      expect([...admins]).toEqual([])
      expect(DeploymentPolicy.isDeploymentAdmin("roninjin10", admins)).toBe(false)
    }
    expect([...DeploymentPolicy.DEFAULT_ADMINS]).toEqual([])
    expect(DeploymentPolicy.isDeploymentAdmin("roninjin10")).toBe(false)
    expect(DeploymentPolicy.isDeploymentAdmin(undefined)).toBe(false)
  })

  test("the configured logins are the deployment admins, whatever their case", async () => {
    const admins = await configured({ DEPLOYMENT_ADMIN_LOGINS: " Maya , devon" })
    expect([...admins]).toEqual(["maya", "devon"])
    expect(DeploymentPolicy.isDeploymentAdmin("MAYA", admins)).toBe(true)
    expect(DeploymentPolicy.isDeploymentAdmin("devon", admins)).toBe(true)
    expect(DeploymentPolicy.isDeploymentAdmin("alice", admins)).toBe(false)
    expect(DeploymentPolicy.isDeploymentAdmin("", admins)).toBe(false)
  })

  test("requireDeploymentAdmin admits a configured admin in person and refuses everyone else", async () => {
    const admins = DeploymentPolicy.parseAdminLogins("maya")
    expect(await Effect.runPromise(DeploymentPolicy.requireDeploymentAdmin(person("maya"), admins))).toBe("maya")
    const refused = async (actor: Actor, set?: ReadonlySet<string>) =>
      Exit.isFailure(await Effect.runPromise(Effect.exit(DeploymentPolicy.requireDeploymentAdmin(actor, set))))
    expect(await refused(person("alice"), admins)).toBe(true)
    // With nobody configured, a repository Admin is still not a deployment admin.
    expect(await refused(person("maya"))).toBe(true)
    expect(await refused({ subject: { kind: "person", id: "p-1" }, role: "admin" }, admins)).toBe(true)
  })

  // R1-Astra-D4-002, R1-NEON-D4-004: a credential acting for an admin holds no deployment authority.
  test.each(["agent", "flow", "sandbox", "app"] as const)("a delegated %s credential for a deployment admin is refused", async (kind) => {
    const admins = DeploymentPolicy.parseAdminLogins("maya")
    const delegated = { ...person("maya"), act: { kind, id: "run-1" } } as Actor
    expect(DeploymentPolicy.holdsDeploymentAuthority(delegated, admins)).toBe(false)
    expect(DeploymentPolicy.holdsDeploymentAuthority(person("maya"), admins)).toBe(true)
    const exit = await Effect.runPromise(Effect.exit(DeploymentPolicy.requireDeploymentAdmin(delegated, admins)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
