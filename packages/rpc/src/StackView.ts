/**
 * Shared item labels for history and terminal views.
 *
 * @since 1.0.0
 */

import type { MythicalAccount, MythicalItem, MythicalStack } from "./Mythical.ts"
import { isSettledItemState } from "./Mythical.ts"

/**
 * Items a lane is working on: from launch until the pull request is open.
 *
 * @category constants
 * @since 1.0.0
 */
export const ACTIVE_ITEM_STATES: ReadonlySet<MythicalItem["state"]> = new Set([
  "running",
  "delivering",
  "integrating",
  "verifying",
  "proposing",
  "waiting",
  "retrying"
])

/**
 * The owner's words for where an item is (#1745): one label per API state.
 * `running` covers planning and implementing (the plan is recorded only when
 * the request run finishes), `waiting` is a verified result waiting on main.
 *
 * @category projections
 * @since 1.0.0
 */
export const itemStateLabel = (item: MythicalItem): string => {
  switch (item.state) {
    case "running":
      return "implementing"
    case "delivering":
      return "checking"
    case "integrating":
      return "rebasing"
    case "verifying":
      return "checking"
    case "waiting":
      return "ready"
    case "proposed":
      return "PR open"
    default:
      return item.state
  }
}

/**
 * `#12 Title` for an issue; a chat item is named by the stack change it made, else its id.
 *
 * @category projections
 * @since 1.0.0
 */
export const itemTitle = (stack: MythicalStack, item: MythicalItem): string => {
  if (item.issue !== undefined) return `#${item.issue.number} ${item.issue.title}`
  return stack.changes.find((change) => change.itemId === item.id)?.title ?? item.id.slice(0, 8)
}

/**
 * The one line under a row: why it stopped, or which paths conflicted.
 *
 * @category projections
 * @since 1.0.0
 */
export const itemReason = (item: MythicalItem): string | undefined => {
  const paths = item.integration?.conflict?.paths ?? []
  // A typed failure's sentence outranks the paths an earlier attempt conflicted in.
  if (item.failure === undefined && item.state === "retrying" && paths.length > 0) return paths.join(", ")
  return item.reason === undefined || item.reason === "" ? undefined : item.reason
}

const PROVIDER_NAMES: Readonly<Record<MythicalAccount["provider"], string>> = { claude: "Claude", codex: "Codex" }

/**
 * The account a lane's latest call used, and how many more served it: `work@example.com +1`.
 *
 * @category projections
 * @since 1.0.0
 */
export const accountLabel = (account: MythicalAccount): string =>
  `${account.label ?? PROVIDER_NAMES[account.provider]}${account.count > 1 ? ` +${account.count - 1}` : ""}`

/**
 * Whether an item is out of the lanes: settled, or its pull request is open.
 *
 * @category projections
 * @since 1.0.0
 */
export function settled(item: MythicalItem): boolean {
  return isSettledItemState(item.state) || item.state === "proposed"
}
