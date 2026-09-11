import { AGENT_ROLES, agentRoleTitle, orderedAgentRoles } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "./state/AppState"

/*
 * The agents as the `+` menus list them (sidebar and composer): a role is
 * available exactly when its harness is installed AND carries a credential
 * for the role's model; otherwise the row is disabled with the reason. Pure,
 * so both menus, the Agents card, the roles paragraph, and their tests read
 * one rule. Custom agents (custom-agents.md) ride the same rule: the list is
 * the app-agents mirror, and the built-in table stands in until it loads.
 */
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
  harnesses: ReadonlyArray<Harness>,
  agents: ReadonlyArray<AgentRole> = AGENT_ROLES
): ReadonlyArray<RoleMenuEntry> =>
  orderedAgentRoles(agents).map((role) => {
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
