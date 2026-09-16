import { guideFlows } from "./entries/guide"
/*
 * Every interactive capability in the app, as a flow.
 *
 * A capability is a `Flow.make` declaration — name, description, capability
 * claims, and typed payload/success schemas — paired with the controller call
 * that runs it through `FlowBinding.make`. The pair is the whole capability:
 * the projected `FlowDescriptor` is what the agent's catalog discloses, and the
 * binding's `run` is what answers the call, so the catalog shown to the model
 * and the code that executes cannot drift apart.
 *
 * Two axes live on the declaration rather than on the UI wrapper:
 *  - capability claims (DESIGN.md §14's three-tier policy): `outbound:*` always
 *    asks, `session:*` asks once per session, `approve:*` is structurally denied
 *    to the agent, and the `app:act` default is free;
 *  - the trigger axis, as `modelInvocable`. A user-only flow is browser
 *    mechanics the human clicks (sign-in, theme, stop, send, maximize); the
 *    descriptor says so, so it never reaches the agent's catalog.
 *
 * Handlers take a DECODED payload. No handler parses argument text: the slash
 * boundary turns `/name <text>` into the flow's payload once, in SlashPayload.ts.
 *
 * One module per namespace under ./entries holds the declarations; this file
 * is the aggregator. It spreads each module's blocks in registration order,
 * which the slash menu, the agent catalog and the commands card all read, so
 * a new namespace is one import plus one spread line here and nothing else.
 * FlowOrder.test.ts pins that order.
 */
import type { FlowEntry } from "./registry"
import type { CommandActions } from "./entries/Declare"
import { accountFlows } from "./entries/account"
import { adminOperatorFlows, adminResetFlows, adminToolFlows } from "./entries/admin"
import { agentFlows, tutorialChangeFlows } from "./entries/agent"
import { agentSessionFlows } from "./entries/agentSession"
import { appFlows } from "./entries/app"
import { appearanceFlows } from "./entries/appearance"
import { approvalFlows } from "./entries/approval"
import { approvalsFlows } from "./entries/approvals"
import { authFlows } from "./entries/auth"
import { billingBalanceFlows, billingPlanFlows } from "./entries/billing"
import { branchesFlows } from "./entries/branches"
import { commitsFlows } from "./entries/commits"
import { browserFlows } from "./entries/browser"
import { cardFlows } from "./entries/card"
import { changeFlows, changeOpenFlows } from "./entries/change"
import { chatCopyFlows, chatFlows, chatReloadFlows, chatSurfacesFlows } from "./entries/chat"
import { cloudFlows } from "./entries/cloud"
import { codeFlows } from "./entries/code"
import { composerFlows } from "./entries/composer"
import { connectSurfaceFlows, connectorFlows } from "./entries/connector"
import { debugFlows, debugVerboseFlows } from "./entries/debug"
import { egressFlows } from "./entries/egress"
import { envFlows } from "./entries/env"
import { featureFlows } from "./entries/feature"
import { filesAddFlows, filesFlows } from "./entries/files"
import { findingsFlows } from "./entries/findings"
import { flowFlows, flowRunStopAllFlows, flowsSurfaceFlows } from "./entries/flow"
import { formFlows } from "./entries/form"
import { frameFlows } from "./entries/frame"
import { githubFlows } from "./entries/github"
import { issuesFlows } from "./entries/issues"
import { setupFlows } from "./entries/setup"
import { notificationsFlows } from "./entries/notifications"
import { paletteFlows } from "./entries/palette"
import { PLUGINS_USER_ONLY_REASON, pluginsFlows, pluginsSurfaceFlows } from "./entries/plugins"
import { prsFlows } from "./entries/prs"
import { repoFlows, repoOpenFlows, tutorialRepositoryFlows } from "./entries/repo"
import { reposImportFlows, reposImportRetryFlows } from "./entries/repos"
import { reviewFlows } from "./entries/review"
import { runsFlows } from "./entries/runs"
import { searchFlows } from "./entries/search"
import { smithersFlows } from "./entries/smithers"
import { secretsFlows } from "./entries/secrets"
import { historyFlows } from "./entries/history"
import { storageFlows } from "./entries/storage"
import { syncFlows } from "./entries/sync"
import { systemFlows } from "./entries/system"
import { tabFlows, tabHarnessFlows } from "./entries/tab"
import { targetFlows } from "./entries/target"
import { toastFlows } from "./entries/toast"
import { triggersFlows } from "./entries/triggers"
import { wikiFlows, wikiSurfaceFlows } from "./entries/wiki"
import { workspaceFlows, workspaceRenameFlows } from "./entries/workspace"
import { worldFlows, worldSurfaceFlows } from "./entries/world"

export type { CommandActions, CommandResult } from "./entries/Declare"
export { Ack } from "./entries/Declare"

/**
 * The flows every session has.
 *
 * @category constructors
 */
/**
 * The ONLY flows that may be listed in the slash menu and still refuse the
 * model ("every workflow in the / menu is available as a tool call" — Will).
 * Each entry is here for a structural reason, not taste; adding to this list
 * is a conscious act pinned by flows/invocable.test.ts.
 */
export const USER_ONLY_VISIBLE: ReadonlyArray<{ readonly name: string; readonly why: string }> = [
  { name: "chat.open", why: "opening Chat and starting the selected microphone mode is the human's gesture" },
  { name: "chat.dictate", why: "microphone capture is the human's explicit gesture" },
  { name: "chat.send", why: "turn mechanics: the model is already the turn; sending would nest one" },
  { name: "chat.stop", why: "turn mechanics: stopping the model's own turn from inside it" },
  { name: "admin.reset", why: "destroys the whole store with no undo; the confirm dialog is the only door" },
  { name: "billing.upgrade", why: "external checkout with real money; the human clicks" },
  { name: "billing.portal", why: "external billing portal; the human clicks" },
  { name: "admin.devtools", why: "admin panel presentation toggle" },
  { name: "debug.backend", why: "admin diagnostics presentation" },
  { name: "debug.grants.reset", why: "admin-only grant wipe" },
  { name: "cloud.sign-in", why: "external browser OAuth on the human's account; the human clicks" },
  { name: "cloud.sign-out", why: "drops the human's cloud credential; the human clicks" },
  { name: "auth.sign-in", why: "the GitHub OAuth redirect yanks the page; the human clicks (auth.prompt is the agent's door)" },
  { name: "auth.sign-out", why: "drops the human's session; the human clicks" },
  { name: "flows", why: "surface switch: the model lists flows with flow.list, which answers as an embedded card" },
  { name: "plugins", why: PLUGINS_USER_ONLY_REASON },
  { name: "palette.open", why: "focus and an overlay are the human's gesture; the model searches with the search.* flows, which answer the same rows as data" }
]

export const baseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...connectSurfaceFlows(actions),
  ...(actions.snapshot?.()?.wiki === true ? wikiSurfaceFlows(actions) : []),
  ...(actions.snapshot?.()?.wiki === true ? worldSurfaceFlows(actions) : []),
  ...flowsSurfaceFlows(actions),
  ...(actions.snapshot?.()?.pluginLibrary === true ? pluginsSurfaceFlows(actions) : []),
  ...appearanceFlows(actions),
  ...chatSurfacesFlows(actions),
  ...debugVerboseFlows(actions),
  ...systemFlows(actions),
  ...chatFlows(actions),
  ...browserFlows(actions),
  ...flowFlows(actions),
  ...triggersFlows(actions),
  ...runsFlows(actions),
  ...flowRunStopAllFlows(actions),
  ...approvalsFlows(actions),
  ...cardFlows(actions),
  ...frameFlows(actions),
  ...chatCopyFlows(actions),
  ...approvalFlows(actions),
  ...connectorFlows(actions),
  ...(actions.snapshot?.()?.wiki === true ? wikiFlows(actions) : []),
  ...(actions.snapshot?.()?.wiki === true ? worldFlows(actions) : []),
  ...authFlows(actions),
  ...accountFlows(actions),
  ...appFlows(actions),
  ...storageFlows(actions),
  ...cloudFlows(actions),
  ...toastFlows(actions),
  ...billingBalanceFlows(actions),
  ...billingPlanFlows(actions),
  ...reposImportFlows(actions),
  ...issuesFlows(actions),
  ...setupFlows(actions),
  ...prsFlows(actions),
  ...featureFlows(actions),
  ...notificationsFlows(actions),
  ...envFlows(actions),
  ...secretsFlows(actions),
  ...(actions.snapshot?.()?.mythicalHistory === true ? historyFlows(actions) : []),
  ...branchesFlows(actions),
  ...commitsFlows(actions),
  ...filesFlows(actions),
  ...codeFlows(actions),
  ...githubFlows(actions),
  ...reposImportRetryFlows(actions),
  ...syncFlows(actions),
  ...workspaceFlows(actions),
  ...egressFlows(actions),
  ...changeFlows(actions),
  ...reviewFlows(actions),
  ...findingsFlows(actions),
  ...chatReloadFlows(actions),
  ...tabHarnessFlows(actions),
  ...agentFlows(actions),
  /* The cloud agent sessions (UI-COVERAGE-GAPS.md "agents · Cloud agent sessions"), in the agent namespace. */
  ...agentSessionFlows(actions),
  ...tutorialChangeFlows(actions),
  ...changeOpenFlows(actions),
  ...formFlows(actions),
  ...tabFlows(actions),
  ...repoFlows(actions),
  ...tutorialRepositoryFlows(actions),
  ...workspaceRenameFlows(actions),
  ...composerFlows(actions),
  ...filesAddFlows(actions),
  ...repoOpenFlows(actions),
  ...targetFlows(actions),
  ...smithersFlows(actions),
  ...searchFlows(actions),
  ...paletteFlows(actions),
  ...(actions.snapshot?.()?.pluginLibrary === true ? pluginsFlows(actions) : []),
  ...guideFlows(actions)
]

/*
 * The admin plugin (Launch Checklist §E — non-enumerable): these flows REGISTER
 * ONLY when the validated session carries admin:true. For every other session
 * they are absent from the registry — not hidden, not disabled — so the
 * enumeration surface (slash menu, agent catalog) of a non-admin session
 * contains no trace of them, and a direct /name invocation resolves exactly
 * like any typo.
 */
export const adminFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...adminResetFlows(actions),
  ...adminToolFlows(actions),
  ...debugFlows(actions),
  ...adminOperatorFlows(actions)
]
