import { describe,expect,test } from "bun:test"
import { readdirSync,readFileSync } from "node:fs"
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

/** Literal JSX bindings, excluding comments, text, and selectors used to find controls. */
const literalBindings = (source: string): Array<{ readonly prop: string; readonly name: string }> => {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ readonly prop: string; readonly name: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const prop = node.name.getText(tree)
      if (prop === "data-flow" || prop === "closeCommand") {
        const value = node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression : node.initializer
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          found.push({ prop, name: value.text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
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
  "onInstall(", // delegated: PluginsSurface.tsx bind it to runCommand("plugins.install", ...)
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
] as const

// Indirections added with the run cards. Scope each literal
// to its component so a similarly named handler cannot inherit the exception.
const DELEGATED_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  // Pre-boot browser navigation: no writable store/controller exists here.
  // Choosing this document's writer is a human tab gesture, not an app command.
  "../StartupError.tsx": ["onClick={useSmithersHere}", "onClick={() => window.location.reload()}"],
  "../ToastAction.tsx": ["onAction(action)"], // ToastStack/App bind the typed action to runCommand(action.flow, action.args)
  "../HelpBubble.tsx": ["onClick={dismiss}"], // restores focus, then onDismiss() dismisses transient help
  "../InputModeMenu.tsx": ["open ? close() : setOpen(true)", "latest.current.onChange(value)"], // transient menu; selection is input.mode at both mounts
  "../cards/LiveTutorialRunBody.tsx": ["scoped("], // runSourceCommand(card.id, onRunCommand) keeps the source frame
  "../cards/WorkflowCards.tsx": ["sendRunCommand("], // the original onRunCommand prop, before the frame wrapper
  "../cards/ApprovalAnswer.tsx": ["onAnswer(", "onClick={send}"], // the answer is a value, not a flow argument; both mounts bind onAnswer to the controller
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

  test("binding discovery reads JSX declarations, never focus-return selectors or comments", () => {
    const source = [
      '// <button data-flow="comment.only" />',
      'const selector = `[data-flow="${flow}"]`',
      'const description = \'closeCommand="text.only"\'',
      'const view = <><button data-flow="app.first-run.dismiss" /><button data-flow={"missing.command"} />',
      '<button data-flow={`missing.template`} /><SurfaceHeader closeCommand="missing.close" />',
      '<button data-flow={action.flow} />{/* <button data-flow="comment.only" /> */}</>'
    ].join("\n")
    const bindings = literalBindings(source)
    expect(bindings).toEqual([
      { prop: "data-flow", name: "app.first-run.dismiss" },
      { prop: "data-flow", name: "missing.command" },
      { prop: "data-flow", name: "missing.template" },
      { prop: "closeCommand", name: "missing.close" }
    ])
    const declared = new Set(["app.first-run.dismiss"])
    expect(bindings.filter(({ name }) => !declared.has(name)).map(({ name }) => name)).toEqual([
      "missing.command", "missing.template", "missing.close"
    ])
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
      // SurfaceHeader renders its close affordance's data-flow from
      // closeCommand, so the literal lives at the call site and is gated here.
      for (const { prop, name } of literalBindings(source)) {
        if (!declared.has(name)) {
          violations.push(`${file}: ${prop}="${name}" is not a registered command`)
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
