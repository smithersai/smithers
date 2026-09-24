import { AGENT_ROLES, agentRoleTitle } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "./state/AppState"

/** Built-in roles available through installed, authenticated harnesses. */
export interface RoleMenuEntry {
  readonly role: AgentRole
  readonly title: string
  readonly available: boolean
  /** Why the row is disabled; empty when available. */
  readonly reason: string
  /** The account the harness reports, for the row's trailing label. */
  readonly account: string
}

export const roleMenuEntries = (
  harnesses: ReadonlyArray<Harness>
): ReadonlyArray<RoleMenuEntry> =>
  AGENT_ROLES.map((role) => {
    const harness = harnesses.find((candidate) => candidate.id === role.harness)
    const title = agentRoleTitle(role)
    if (harness === undefined || harness.status === "unavailable") {
      return { role, title, available: false, reason: `${harnessName(role, harness)} is not installed`, account: "" }
    }
    if (harness.status === "binary-only") {
      return {
        role,
        title,
        available: false,
        reason: `${harness.displayName} has no credential for ${role.model.label}`,
        account: ""
      }
    }
    return {
      role,
      title,
      available: true,
      reason: "",
      account: harness.account?.email ?? harness.account?.label ?? ""
    }
  })

const harnessName = (role: AgentRole, harness: Harness | undefined): string => harness?.displayName ?? role.harness
