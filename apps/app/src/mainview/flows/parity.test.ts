import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/*
 * The launch-law gate: every interactive affordance in the app routes through
 * the command registry (`runCommand`), never a direct
 * controller call. This test enumerates the action props in every surface
 * file and asserts each one either dispatches through the registry itself or
 * is a delegated prop whose binding site does. Adding a button without a
 * command behind it fails this test.
 */

const read = (relative: string): string => {
  let source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
  // Inspect the shared binding as its equivalent JSX, keeping every existing
  // command and affordance check applicable to both binding spellings.
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxSpreadAttribute(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === "flowAction") {
      const [run, name, args] = node.expression.arguments
      if (!run || !name) throw new Error("A flow binding needs its dispatcher and command")
      const label = ts.isStringLiteral(name) ? JSON.stringify(name.text) : `{${name.getText(tree)}}`
      edits.push({ start: node.getStart(tree), end: node.end, text: `data-flow=${label} onClick={() => ${run.getText(tree)}(${name.getText(tree)}${args ? `, ${args.getText(tree)}` : ""})}` })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

/**
 * The registry source: the Flows.ts aggregator plus every namespace module
 * under ./entries, read together so a flow declared in any module counts.
 */
const registrySources = (): string => {
  const entries = fileURLToPath(new URL("./entries/", import.meta.url))
  return [read("./Flows.ts"), ...readdirSync(entries).sort().map((file) => read(`./entries/${file}`))].join("\n")
}

/**
 * Every component file under src/mainview, discovered rather than listed: a new
 * surface added with a command-less button has to fail this gate, and a
 * hand-maintained list would silently exempt it.
 */
const surfaceFiles = (): Array<string> => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .map((entry) => `../${entry.split("\\").join("/")}`)
    .sort()
}

const ACTION_PROPS = ["onClick", "onSubmit", "onStop", "onConfirm", "onDecide", "onSelect", "onClose"] as const

interface HandlerRef {
  readonly prop: string
  /** The line the action prop appears on. */
  readonly line: string
  readonly context: string
}

/** Every action-prop occurrence with the following lines (handlers can wrap). */
const handlers = (source: string): Array<HandlerRef> => {
  const lines = source.split("\n")
  const found: Array<HandlerRef> = []
  lines.forEach((line, index) => {
    for (const prop of ACTION_PROPS) {
      const pattern = new RegExp(`\\b${prop}=`)
      if (!pattern.test(line)) continue
      found.push({ prop, line, context: lines.slice(index, index + 4).join("\n") })
    }
  })
  return found
}

/**
 * Handlers that legitimately do NOT dispatch a command, with the reason each
 * is not a launch-law violation. Anything not listed here MUST route through
 * the registry.
 */
const PRESENTATION_ONLY = [
  "setSlashMenu", // slash-menu hover highlight: local presentation state
  "setCopied", // copy feedback flash; the clipboard write routes via onCopy
  "toggleConnectMenu", // opens the composer's connect origins menu; every entry inside dispatches its own command
  "setSelectedPath", // world card doc selection: which note the embedded editor shows — local presentation state
  "onDismissDrawer(", // graph card detail drawer close: local presentation state (which node is focused)
  "setOpenLog(", // run timeline log panel: which row's log is open — local presentation state
  "setDeleteDraft", // workspace card delete: the typed-confirm row's open state and its draft — local presentation state; the act itself rides workspace.delete
  "setDisconnectArmed", // connector-setup card disconnect: the confirm row's open state — local presentation state; the act itself rides linear.disconnect
  "onRunCommand(", // delegated: App.tsx binds it to the registry's runCommand
  "onChoose(", // delegated: Composer.tsx routes a palette row through runCommand, or edits the draft (a namespace, a prefix)
  // Card maximize/minimize: each calls the delegated onMaximize/onMinimize (bound to card.maximize /
  // card.minimize at the App.tsx and CardTabBody binding sites) and then hands focus to the button
  // that replaces the one pressed, so Escape keeps a shell to land on.
  "maximizeThenFocus",
  "minimizeThenFocus",
  // C-1 (wave 13): these two are NOT local state — calling either dispatches
  // runCommand("chat.surfaces"). The wrappers stay listed only
  // because the registry call is one indirection away from the onClick.
  "openNamespace", // slash-menu tree: opening a namespace rewrites the draft to `/ns.` — a draft edit, never a command
  "openMenu", // dispatches runCommand("chat.surfaces") — the /chat.surfaces command
  "closeMenu", // dispatches runCommand("chat.surfaces"); the entry itself runs its own command
  "onCopy(", // delegated: TranscriptMessage.tsx binds it to runCommand("chat.copy-message", ...)
  "onDownload}", // delegated: TranscriptMessage.tsx binds StorageRecoveryButton to storage.recovery.export
  "onDecideApproval(", // delegated: App.tsx binds it to approval.approve / approval.deny
  "onRecoAction(", // delegated: App.tsx binds it to reco.accept / reco.edit / reco.dismiss
  "onGrantConfirm(", // delegated: App.tsx binds it to admin.grant.confirm
  "onGrantCancel(", // delegated: App.tsx binds it to admin.grant.cancel
  "onQueueApprove(", // delegated: App.tsx binds it to admin.queue.approve
  "onDismiss(", // delegated: App.tsx binds it to runCommand("toast.dismiss", ...)
  "onMaximize(", // delegated: App.tsx binds it to runCommand("card.maximize", ...)
  "onMinimize(", // delegated: App.tsx binds it to card.minimize
  "onFrameBack", // delegated: App.tsx binds it to frame.back
  "onFrameForward", // delegated: App.tsx binds it to frame.forward
  "onForkFrame", // delegated: App.tsx binds it to frame.fork
  "onOpenInTab(", // delegated: App.tsx and tabs/CardTabBody.tsx bind it to runCommand("tab.card", ...)
  "onInstall(", // delegated: PluginsSurface.tsx and the guide's Library bind it to runCommand("plugins.install", ...)
  "onRemove(", // delegated: PluginsSurface.tsx binds it to runCommand("plugins.remove", ...)
  "onOpen(", // delegated: the plugin rail's binding sites bind it to runCommand(<the entry's own flow>)
  "onConnectGitHub(", // delegated: App.tsx binds it to auth.sign-in
  "onConnectLocal(", // delegated: App.tsx binds it to runCommand("connector.add", ...)
  "onRunWorkflow(", // delegated: App.tsx binds it to runCommand("flow.run", ...)
  "onStopRun(", // delegated: App.tsx binds it to runCommand("flow.run.stop", ...)
  "onRetryRun(", // delegated: App.tsx binds it to runCommand("flow.run.retry", ...)
  "onChooseWorkflowRepo(", // delegated: App.tsx binds it to runCommand("flow.repo.choose", ...)
  "onConfirm}", // SurfaceChrome delegates to its binding site
  "onCancel}", // dismissing a dialog changes no application state
  "onClose}", // SurfaceChrome delegates to its binding site
  "runLessonAction(", // delegated: GuideShell.tsx binds the lesson's button to runCommand(<the lesson's own flow>)
  "dispatch(\"reel-" // delegated: Reel.tsx's dispatch is runCommand("onboarding.act", ...)
] as const

// Indirections added with the focused guide and run cards. Scope each literal
// to its component so a similarly named handler cannot inherit the exception.
const DELEGATED_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  "../onboarding/GuideShell.tsx": ["onClick={advanceGuidance}"], // advances transient introductory help, without invoking a capability
  "../ToastAction.tsx": ["onAction(action)"], // ToastStack/App and GuideShell bind the typed action to runCommand(action.flow, action.args)
  "../HelpBubble.tsx": ["onClick={dismiss}"], // restores focus, then onDismiss() dismisses transient help
  "../InputModeMenu.tsx": ["open ? close() : setOpen(true)", "latest.current.onChange(value)"], // transient menu; selection is input.mode at both mounts
  "../cards/LiveTutorialRunBody.tsx": ["scoped("], // runSourceCommand(card.id, onRunCommand) keeps the source frame
  "../cards/WorkflowCards.tsx": ["sendRunCommand("], // the original onRunCommand prop, before the frame wrapper
}

const routesThroughRegistry = (context: string): boolean =>
  context.includes("runCommand") || context.includes("runSlashCommand")

describe("launch-law parity: every affordance is a command", () => {
  const files = Object.fromEntries(surfaceFiles().map((file) => [file, read(file)]))

  test("the discovered surface set covers every component file", () => {
    // A new .tsx under src/mainview joins the scan automatically; this pins that
    // discovery actually found the known surfaces (a broken glob fails loudly).
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "../App.tsx",
        "../TranscriptMessage.tsx",
        "../ChatCards.tsx",
        "../ConnectorsSurface.tsx",
        "../SurfaceChrome.tsx"
      ])
    )
  })

  test("every action prop routes through the registry or is allowlisted", () => {
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const handler of handlers(source)) {
        if (routesThroughRegistry(handler.context)) continue
        // The allowlist exempts the handler that NAMES the token, not any
        // handler that happens to sit near one: a complete one-line
        // handler matches against its own line only, so it can no longer
        // ride a neighbour's exemption through the four-line window. A
        // handler that opens a multi-line body may name its token on the
        // body's own lines.
        const opensBody = /=>\s*\{?\s*$/.test(handler.line)
        const allowance = opensBody ? handler.context : handler.line
        if (PRESENTATION_ONLY.some((token) => allowance.includes(token))) continue
        if (DELEGATED_HANDLERS[file]?.some((token) => allowance.includes(token))) continue
        violations.push(`${file}: ${handler.prop} → ${handler.context.split("\n")[0]?.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("the focused guide and run-card indirections retain their bindings", () => {
    expect(files["../HelpBubble.tsx"]).toContain("onDismiss()")
    expect(files["../InputModeMenu.tsx"]).toContain('data-flow="input.mode"')
    for (const file of ["../App.tsx", "../onboarding/GuideShell.tsx"]) {
      expect(files[file]).toContain('onChange={mode => controller.runCommand("input.mode", mode)}')
    }
    expect(files["../cards/LiveTutorialRunBody.tsx"]).toContain("const scoped=runSourceCommand(card.id,onRunCommand)")
    expect(files["../cards/WorkflowCards.tsx"]).toContain("onRunCommand: sendRunCommand")
  })

  test("the expected affordances are all present (removal fails loudly too)", () => {
    // Files with no affordances at all (the composition root) are not pinned;
    // the moment one grows a handler it appears here and must be accounted for.
    const counts = Object.fromEntries(
      Object.entries(files)
        .map(([file, source]) => [file, handlers(source).length] as const)
        .filter(([, count]) => count > 0)
    )
    expect(counts).toEqual({
      "../onboarding/GuideShell.tsx": 11, // Toast dismissal is owned by ToastStack; includes dock Close and dictation controls.
      // The optional capability reel after the last lesson: its launch pill and its Back.
      "../onboarding/Reel.tsx": 4, // Delegates to the shared onboarding and existing app flows; the Command-K overlay is the summoned composer with no chrome of its own. The sidebar lists Wiki and Mythical history only — no Library entry.
      /*
       * The chrome Sign in button (LOCAL-APP.md: sign-in is an option in the
       * chrome, never a gate on the chat) is one of ChromeBar's nine below.
       *
       * Shell bindings stay here; composer bindings are pinned independently
       * now that the hot path is its own module.
       */
      // 15 − the corner balance chip: the balance is one act away (/balance), never main-page chrome.
      // +1 (ask 5): the Flows pane's back-to-conversation close, like World's.
      // +1: the Flows pane's Triggers button, the button door of triggers.list.
      // +1: the Wiki pane's Factory button, the button door of factory.show.
      // +1 (Librarian L5): the Wiki pane's Graph button, the button door of wiki.graph.
      "../App.tsx": 5,
      // Shared by the workspace and tutorial: copy, message CTA, retry, and explain.
      "../TranscriptMessage.tsx": 4,
      "../StorageRecoveryButton.tsx": 1,
      "../FlowsSurface.tsx": 2,
      "../WorldSurface.tsx": 8,
      "../HelpBubble.tsx": 1,
      "../InputModeMenu.tsx": 2,
      "../SessionNavigation.tsx": 2,
      "../cards/CodingVibeCard.tsx": 1,
      "../cards/LiveTutorialRunBody.tsx": 7,
      "../cards/RepositoryUpdateCard.tsx": 3,
      "../tabs/RepoTree.tsx": 1,
      /*
       * The Library (the `plugins` surface and the guided introduction share
       * it): Install and Remove on a row, and the rail button each installed
       * plugin contributed. Every one is a delegated prop its binding site
       * runs through the registry.
       */
      "../plugins/PluginGallery.tsx": 2,
      "../plugins/PluginRail.tsx": 1,
      "../plugins/PluginsSurface.tsx": 1,
      /* 11 = 10 + the origin chip's "rev N exists · view" (lane change step 4; renders only when both seqs are known). */
      "../Composer.tsx": 9,
      // 6 = 5 + the empty state's own import affordance (§11.6): with nothing
      // connected the pane stated a fact and offered no move.
      "../ConnectorsSurface.tsx": 6,
      /*
       * The card shell: the maximize backdrop, the frame back / forward /
       * fork, the maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"),
       * Restore and Maximize. Every card body lives in its family file under
       * cards/ and is pinned there.
       */
      "../ChatCards.tsx": 10,
      /* The turn's approval card: approve and deny. */
      "../cards/ApprovalCard.tsx": 2,
      /* The admin grant confirm: Post the grant and Cancel. */
      "../cards/BillingCards.tsx": 2,
      /* The access-request queue's Approve. */
      "../cards/AdminCards.tsx": 1,
      /*
       * The run card's lane-runs acts: the two secondary tabs under the trace
       * (Steps, Transcript; Events under verbose), Check again and Stop
       * watching, Resume, Stop, Run again, the steer row's send, the
       * repository chooser's row and the workflow list's Run.
       */
      "../cards/WorkflowCards.tsx": 14,
      "../DevtoolsPanel.tsx": 1,
      "../SearchPalette.tsx": 6, // + Ask Smithers, the first row of an empty ⌘K
      "../SurfaceChrome.tsx": 3,
      "../ToastAction.tsx": 1,
      "../ToastStack.tsx": 1,
      /* The multi-parity domain cards: every handler routes through onRunCommand. */
      /* 3 = 2 + the issue card's Link to Linear…, the door onto issues.link-linear's form (lane sync). */
      "../cards/IssueCards.tsx": 9, // + the detail's comment box submit (issues.comment)
      "../cards/LandingCards.tsx": 5, // Includes the durable PR tab flow.
      "../cards/FileCards.tsx": 3,
      /* Mark-all-read. */
      "../cards/NotificationsCard.tsx": 1,
      /* The account card's Sign out door (auth.sign-out through onRunCommand). */
      "../cards/AccountCard.tsx": 1,
      /* 2 = Try again + the done state's Open the workspace (lane sync). */
      "../cards/RepoImportCard.tsx": 2,
      // The tutorial's ranked chooser: one row button plus Skip.
      "../cards/RepositoryChoiceCard.tsx": 2,
      /*
       * Lane sync (ADR 0005): the connector-setup card's Open Linear, the
       * per-team picks, the repository pick, Connect, the connected state's
       * Sync now / Activity / Disconnect (the arming click and the confirm
       * row's typed-key send), the GitHub card's Open GitHub / Re-check /
       * Reconcile, and the sync-ops card's Retry / Show more / Load older —
       * all through onRunCommand with data-flow set.
       */
      "../cards/SyncCards.tsx": 14,
      /* The /theme picker: nine swatches, one shared handler through onRunCommand. */
      "../cards/ThemePickerCard.tsx": 1,
      /*
       * Lane citc: the workspace card's five facet tabs, the terminal facet's
       * Open and per-session Destroy, the snapshots' Fork-from, Template and
       * Delete, Suspend, Resume, Fork, Snapshot, the failed card's Retry, and
       * the typed delete confirm — all through onRunCommand; the draft input
       * rides the allowlist above. 15 = 13 + lane L3's ssh-host Copy (through
       * chat.copy-message) and the Egress facet's "Load older"; the Files
       * facet's rows belong to the imported FileListCardBody and are counted
       * in ITS file. 17 = 15 + lane L3b's Desktop facet: Rotate session and
       * the 409's Resume. The create affordance's three kind buttons share one
       * handler, and so does the facet strip (the Desktop tab mints through
       * workspace.desktop, every other tab switches through workspace.facet).
       * 20 = 19 + the Desktop facet's "Open a new box": the only door for a
       * box whose image predates the desktop tools, where a Retry is a door
       * onto a wall.
       */
      "../cards/WorkspaceCard.tsx": 20,
      /*
       * The target-graph cards: the graph drawer's close/copy/open/run acts
       * (4), the timeline row's log toggle (1), the history row's replay
       * select and the affected row's show-in-graph (1 each, both
       * onRunCommand).
       */
      "../cards/GraphCard.tsx": 4,
      "../cards/HistoryCard.tsx": 2,
      "../cards/RunTimelineCard.tsx": 1,
      /*
       * The run trace: the live return, the two presentation switches (Turns
       * and Timeline), the filters, the turn rows, the engine rows, the
       * breadcrumbs, the tree rows, the timeline bars and the recorded child
       * link. Every button enters onRunCommand and persists in the same card.
       */
      "../cards/RunTraceCard.tsx": 11,
      /*
       * Lane runs: the run inbox's Open per row, its All/status filter chips,
       * and the Stop-all footer (all through onRunCommand), plus the
       * approvals inbox's two decision acts (approval.approve / approval.deny
       * through the delegated onDecideApproval).
       */
      "../cards/RunsCards.tsx": 10,
      "../cards/SearchResultsCard.tsx": 2,
      "../cards/RunHistoryCard.tsx": 1,
      "../cards/AffectedCard.tsx": 1,
      // Agents as data (custom-agents.md): Launch, Edit, Remove, New agent.
      /* 6 = the Agents card's Launch / Edit / Remove and New agent, the subagent card's Open tab, + the cloud session card's Stop (agent.session.stop). */
      "../cards/AgentCards.tsx": 6,
      "../cards/AnonymousCeilingCard.tsx": 1,
      // THE FORM LAW (flow-forms.md): the generic form's Cancel (card.dismiss) and Submit (form.submit); fields commit on blur/change.
      "../cards/FlowFormCards.tsx": 2,
      /*
       * The repository welcome and its three answers (controller/onboarding.ts):
       * every door (the welcome's three, the maintainer's reads, the
       * contributor's three, the explore card's guide rows) is one shared
       * handler through onRunCommand with data-flow set.
       */
      "../cards/OnboardingCards.tsx": 1,
      /*
       * The repository's home pane (controller/onboarding.ts): the featured
       * flows' doors (flow.run) and Open PACKAGE.ts (files.read) are one
       * shared handler through onRunCommand with data-flow set; links are
       * anchors, not buttons.
       */
      "../cards/HomeCards.tsx": 1,
      /*
       * Lane change (ADR 0003) + lane L1 (ADR 0004, the live plue routes):
       * the change card's facet tabs, Land / Split ready / Revert / Full
       * diff, the conflict rows' Resolve, the Diff facet's two pickers, its
       * since-my-review and show-all, the file rows' one-file diff, the
       * Checks picker, Open the computer, the findings' Please fix and Not
       * useful, the review facet's show-all and thread acts, the history
       * rows' Diff to current, and the diff card's re-read — all through
       * onRunCommand with data-flow set.
       */
      "../cards/ChangeCards.tsx": 24,
      /*
       * The plan inside a run card: Inspect review feedback and Inspect failed
       * execution (runs.trace.select), Vibe this change (flow.run), Check
       * available flows (flow.list), the predicted Change rows
       * (runs.coding.select), the tutorial plan's Start (agent.change.start)
       * and, once started, Open the run (card.maximize) — all through
       * onRunCommand with data-flow set.
       */
      "../cards/CodingPlanCard.tsx": 7,
      "../cards/CodingPocCard.tsx": 2, // Native execution inspection and existing steering form.
      "../cards/CommitPickCard.tsx": 1, // change.open (the checkboxes are change.pick inputs, counted as fields)
      /* The commits cards: a row's and a parent's commits.read, and the sha chip's chat.copy-message — all through onRunCommand. */
      "../cards/CommitCards.tsx": 3,
      "../cards/BranchesCard.tsx": 1, // a row opens that branch's commits (commits.list)
      /*
       * Connection, world and browser card interactions, plus the embedded
       * wiki collaboration cards (ad438463a6): page Previous/Next and the
       * pager's onSelect, the view-mode pickers (wiki.card.view), cloud
       * Open page, and Refresh (wiki.sync) — all through onRunCommand.
       */
      "../cards/ConversationCards.tsx": 11, // The empty Wiki now offers wiki.create.
      /*
       * The targets table: History in the toolbar, the view, kind and state
       * chips (target.filter), each row's star (target.star / unstar),
       * select / Run / Timeline, the drawer's
       * close, Open source, Replay, Run, Graph, Explain, and the target-run
       * card's Explain — all through onRunCommand.
       */
      "../cards/TargetCards.tsx": 26,
      /* The factory card: one Open per present infra file, one shared handler through onRunCommand (files.read). */
      "../cards/FactoryCard.tsx": 1,
      /* The dispatcher card's Register door, the button door of triggers.register (factory mock 2; sign-in is the door). */
      "../cards/TriggersCard.tsx": 1,
      /* Librarian L5: the rail card's Open and note rows (wiki.open) and the graph card's Refresh (wiki.graph). */
      "../cards/WikiCards.tsx": 3,
      /*
       * The sidebar (docs/LOCAL-APP.md "Tabs"): the list's select and close
       * per tab, the Repos section's empty "Select a repo" row, each repo
       * row's select, `+`, and unpin, the `+` trigger, its backdrop, the
       * Terminal row, the available and unavailable harness rows, Sign in,
       * the admin reset, and the theme toggle (chrome that stays visible on
       * every tab).
       */
      /* 23 = 22 + the chrome-actions footer's Download the app (docs/web-mode/PLAN.md §3; renders only where app.download is registered, the cloud host). */
      /* 25 = 24 + the footer's Secrets button, the button door of secrets.list (renders only where the flow registers, the cloud host). */
      /* 26 = 25 + the footer's Dispatcher button, the button door of triggers.list (design session 2026-09-07 chrome; cloud host only). */
      /* 27 = 26 + the footer's Account button, the button door of account.show (factory mock 21; renders where an identity seam exists). */
      /* 28 = 27 + the footer's History button, the button door of history.show (design session 2026-09-07 chrome; cloud host only). */
      /* 30 = 28 + the footer's Wiki and Flows buttons, the button doors of the `wiki` and `flows` surface switches (the chrome is exactly Wiki, Dispatcher, Flows, Secrets, History, Account). */
      "../tabs/ChromeBar.tsx": 30,
      /* The live-process close question: confirm through tab.close.confirm. */
      "../tabs/TabBodies.tsx": 1
    })
  })

  test("delegated props are bound to commands at their call sites", () => {
    const app = files["../App.tsx"]
    const message = files["../TranscriptMessage.tsx"]
    expect(app).toContain("<TranscriptMessage")
    expect(files["../onboarding/GuideShell.tsx"]).toContain("<TranscriptMessage")
    expect(message).toMatch(/onDownload=\{\(\) => \{\s*controller\.runCommand\(STORAGE_RECOVERY_EXPORT\)/)
    expect(message).toContain("runCommand(\"chat.copy-message\"")
    expect(message).toContain("runCommand(\"chat.retry\"")
    expect(message).toMatch(/runCommand\(\s*"agent\.explain"/)
    expect(app).toContain("runCommand(\"toast.dismiss\"")
    const connectors = files["../ConnectorsSurface.tsx"]
    expect(connectors).toContain("runCommand(\"connector.downgrade\"")
    expect(connectors).toContain("runCommand(\"connector.remove\"")
  })

  /*
   * A card's acts are bound in ONE place (cards/CardActions.ts) that the
   * transcript and a card tab both spread, so the two copies cannot drift —
   * the tab used to keep its own and had no frame controls at all. Both call
   * sites are pinned here, so deleting the shared binding fails loudly.
   */
  test("every card act is bound once, and both card surfaces use that binding", () => {
    const actions = read("../cards/CardActions.ts")
    expect(actions).toContain("\"approval.approve\"")
    expect(actions).toContain("\"approval.deny\"")
    expect(actions).toContain("runCommand(\"admin.grant.confirm\"")
    expect(actions).toContain("runCommand(\"admin.grant.cancel\"")
    expect(actions).toContain("runCommand(\"admin.queue.approve\"")
    expect(actions).toContain("runCommand(\"card.maximize\"")
    expect(actions).toContain("runCommand(\"card.minimize\"")
    expect(actions).toContain("runCommand(\"frame.back\"")
    expect(actions).toContain("runCommand(\"frame.forward\"")
    expect(actions).toContain("runCommand(\"frame.fork\"")
    expect(actions).toContain("runCommand(\"tab.card\"")
    expect(actions).toContain("runCommand(\"auth.sign-in\"")
    expect(actions).toContain("runCommand(\"connector.add\"")
    expect(actions).toContain("runCommand(\"flow.run\"")
    expect(actions).toContain("runCommand(\"flow.run.stop\"")
    expect(actions).toContain("runCommand(\"flow.run.retry\"")
    expect(actions).toContain("runCommand(\"flow.repo.choose\"")
    expect(actions).toContain("runCommand(\"wiki.edit\"")
    for (const surface of ["../App.tsx", "../tabs/CardTabBody.tsx"] as const) {
      expect(files[surface]).toContain("cardActions(controller)")
    }
  })

  /*
   * §2a/§2f — no fabricated prompt pills, ever. A pill is a command
   * BINDING; a pill carrying free text for the model is a violation unless
   * it is explicitly a composer-prefill affordance (none exist). The banned
   * literals are the slop will named verbatim; the `suggest` command was
   * the fabricated-prompt mechanism and is deleted; the suggestion set is
   * derived in App.tsx from live state (empty is correct).
   */
  test("no pill carries a prompt string for the model, and no banned generic pill exists", () => {
    const bannedLiterals = [
      "Build my work queue",
      "Build a work queue",
      "Plan my day",
      "Help me plan my day",
      "Help me connect GitHub",
      "What should I do next?"
    ]
    for (const [, source] of Object.entries(files)) {
      for (const literal of bannedLiterals) {
        expect(source).not.toContain(literal)
      }
      // The prompt-pill shape itself: a suggestion carrying prompt text.
      expect(source).not.toContain("prompt: action.prompt")
      expect(source).not.toContain("suggestion.prompt")
    }
    const registrySource = registrySources()
    expect(registrySource).not.toContain("\"suggest\"")
    // The pill row binds commands directly (§2a): the suggestion markup
    // carries the command, and the click invokes it — never send().
    const app = files["../App.tsx"] ?? ""
    expect(app).toContain("data-flow={suggestion.flow}")
    expect(app).not.toContain("data-flow=\"suggest\"")
    // No standing composer status chrome (§2g): calm is the budget.
    expect(app).not.toContain("statusText=")
  })

  /*
   * Wave 13 C-1 — the gap the live sweep found: the static gate verified
   * data-flow bindings and allowlisted presentation-only handlers, but a
   * button with NEITHER (the "Surfaces" menu trigger, whose open/close was
   * allowlisted as local state) shipped unbound. This is the live C-1 rule
   * applied to the source: a button without a data-flow binding must have
   * a static label whose words resolve to a registered command's name or
   * summary — exactly what the launch checklist checks against the DOM.
   */
  test("a button with no data-flow binding has a label that resolves to a registered command", () => {
    const registrySource = registrySources()
    const names = [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    const summaries = [...registrySource.matchAll(/\bsummary:\s*"([^"]+)"/g)].map((match) =>
      (match[1] as string).toLowerCase()
    )
    const resolves = (label: string): boolean => {
      const words = label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2)
      if (words.length === 0) return true
      // EVERY word must resolve: the old any-word rule passed a label on a
      // single common word ("open", "run") no matter what the rest of it
      // promised, which is exactly the fuzz a mis-bound button hides in.
      return words.every(
        (word) =>
          names.some((name) => name.includes(word) || word.includes(name)) ||
          summaries.some((summary) => summary.includes(word))
      )
    }
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      const lines = source.split("\n")
      lines.forEach((line, index) => {
        const label = /(?:aria-label|title)="([^"]+)"/.exec(line)?.[1]
        if (label === undefined) return
        // The element the label belongs to: the nearest enclosing tag start.
        let start = index
        while (start > 0 && !/^\s*<[A-Za-z]/.test(lines[start] ?? "")) start -= 1
        if (!/^\s*<(?:button|Button)\b/.test(lines[start] ?? "")) return
        const chunk = lines.slice(start, Math.min(lines.length, index + 12)).join("\n")
        if (chunk.includes("data-flow")) return
        if (!resolves(label)) {
          violations.push(`${file}: button "${label}" has no data-flow and resolves to no registered command`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test("every data-flow binding names a registered command, and the app exposes the registry manifest", () => {
    // The launch checklist reads the DOM, not the source: `.app-shell`
    // carries the live registry manifest (data-flows) and every
    // machine-legible affordance declares its command (data-flow). A
    // binding naming a command the registry does not have is a lie both
    // gates can catch here.
    const app = files["../App.tsx"]
    expect(app).toContain("const flows = controller.commands.all()")
    expect(app).toContain('data-flows={flows.map((command) => command.name).join(" ")}')
    // Registry names from the registry source itself — the same file the
    // runtime registers — so a renamed command fails this gate.
    const registrySource = registrySources()
    const declared = new Set(
      [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    )
    expect(declared.size).toBeGreaterThan(0)
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const match of source.matchAll(/data-flow="([^"]+)"/g)) {
        const name = match[1]
        if (name !== undefined && !declared.has(name)) {
          violations.push(`${file}: data-flow="${name}" is not a registered command`)
        }
      }
      // SurfaceHeader renders its close affordance's data-flow from
      // closeCommand, so the literal lives at the call site and is gated here.
      for (const match of source.matchAll(/closeCommand="([^"]+)"/g)) {
        const name = match[1]
        if (name !== undefined && !declared.has(name)) {
          violations.push(`${file}: closeCommand="${name}" is not a registered command`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("every embedded pane closes back to the conversation, not to some other surface", () => {
    // The chat-first contract: a pane's only exit is /chat. A pane wired to
    // close into another takeover would pass the registry gate above and still
    // break the contract, so the target itself is pinned.
    const panes = ["../WorldSurface.tsx", "../FlowsSurface.tsx", "../ConnectorsSurface.tsx"] as const
    for (const pane of panes) {
      const source = files[pane] ?? ""
      expect(source).toContain("closeCommand=\"chat\"")
      const targets = [...source.matchAll(/closeCommand="([^"]+)"/g)].map((match) => match[1])
      expect(targets.every((target) => target === "chat")).toBe(true)
    }
    // Every SurfaceHeader mounted anywhere declares one (a pane with an
    // unnamed close is exactly the affordance this gate exists to catch).
    for (const [file, source] of Object.entries(files)) {
      if (file === "../SurfaceChrome.tsx") continue
      const mounts = source.split("<SurfaceHeader").length - 1
      const declared = source.split("closeCommand=").length - 1
      expect(`${file}: ${mounts} SurfaceHeader / ${declared} closeCommand`).toBe(
        `${file}: ${mounts} SurfaceHeader / ${mounts} closeCommand`
      )
    }
  })

  /*
   * The two look-and-feel axes, at their binding sites: the corner button IS
   * the light/dark toggle (/dark-mode), and /theme is the palette command
   * that takes its key as an argument. Both are model-invocable now — every
   * listed flow is a tool call (flows/invocable.test.ts) — so this test
   * guards the binding sites and the args hint, not the trigger axis.
   */
  test("the light/dark toggle and the color theme are separate commands the model can call", () => {
    // The toggle lives in the sidebar's bottom chrome, so it is on screen in every tab.
    const chrome = files["../tabs/ChromeBar.tsx"] ?? ""
    expect(chrome).toContain("runCommand(\"appearance.dark-mode\")")
    expect(chrome).not.toContain("runCommand(\"appearance.theme\")")
    expect(files["../App.tsx"] ?? "").not.toContain("runCommand(\"appearance.dark-mode\")")
    const registrySource = registrySources()
    // A declaration is a const literal (`const THEME = { ... }`); the slice ends
    // at the literal's close.
    const entry = (name: string): string => {
      const start = registrySource.indexOf(`name: "${name}"`)
      expect(start).toBeGreaterThan(-1)
      return registrySource.slice(start, registrySource.indexOf("\n  }\n", start))
    }
    // Listed flows are model-invocable (Will's rule; flows/invocable.test.ts
    // pins the invariant); the args hint is what makes
    // `/appearance.theme <palette>` parse as an invocation.
    expect(entry("appearance.theme")).not.toContain("userOnly")
    expect(entry("appearance.theme")).toContain("args:")
    expect(entry("appearance.dark-mode")).not.toContain("userOnly")
    // The toggle is its own flow, separate from the palette flow.
    expect(entry("appearance.dark-mode")).not.toContain("hidden")
  })

  test("the slash menu wrapper dispatches through the registry", () => {
    const composer = files["../Composer.tsx"]
    const wrapper = composer.slice(
      composer.indexOf("const runSlashCommand"),
      composer.indexOf("const onComposerKeyDown")
    )
    expect(wrapper).toContain("controller.runCommand")
  })
})
