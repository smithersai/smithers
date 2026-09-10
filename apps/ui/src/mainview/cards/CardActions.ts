/*
 * The CardView command bindings, built once per controller.
 *
 * Every act a card raises is a flow name, and the transcript (App.tsx) and a
 * card tab (tabs/CardTabBody.tsx) bind the SAME ones — the card in the tab is
 * a presentation of the card in the transcript, never a second implementation.
 * Both used to hold their own copy of the same eighteen inline arrows, and the
 * copies drifted: the tab never bound onFrameBack, onFrameForward or
 * onForkFrame, so the three frame controls a maximized card renders did
 * nothing there. Being fresh closures on every render, they also defeated
 * memoization — one streaming token re-ran the render function of every card
 * body in the transcript.
 *
 * The bindings depend on nothing but the controller, so they are built once
 * against it and reused: same controller, same object, props CardView's
 * React.memo can compare.
 */
import type { CardViewProps } from "../ChatCards"
import type { AppController } from "../state/AppController"

/** The CardView props a controller alone decides: the flow bindings. */
type CardBindings = Omit<CardViewProps, "card" | "maximized" | "worldDocuments" | "debugVerbose" | "signedOut" | "workflowCatalogs">

const bound = new WeakMap<AppController, CardBindings>()

/** Every CardView callback for this controller, stable across renders. */
export const cardActions = (controller: AppController): CardBindings => {
  const cached = bound.get(controller)
  if (cached !== undefined) return cached
  const actions: CardBindings = {
    onDecideApproval: (id, decision) =>
      controller.runCommandArgs(
        decision === "approved" ? "approval.approve" : "approval.deny",
        id
      ),
    onGrantConfirm: (id) => controller.runCommandArgs("admin.grant.confirm", id),
    onGrantCancel: (id) => controller.runCommandArgs("admin.grant.cancel", id),
    onQueueApprove: (login) => controller.runCommandArgs("admin.queue.approve", login),
    onMaximize: (id) => controller.runCommandArgs("card.maximize", id),
    onMinimize: () => controller.runCommand("card.minimize"),
    onFrameBack: () => controller.runCommand("frame.back"),
    onFrameForward: () => controller.runCommand("frame.forward"),
    onForkFrame: () => controller.runCommand("frame.fork"),
    onOpenInTab: (id) => controller.runCommandArgs("tab.card", id),
    onConnectGitHub: () => controller.runCommand("auth.sign-in"),
    onConnectLocal: () => controller.runCommandArgs("connector.add", "read"),
    onRunWorkflow: (name) => controller.runCommandArgs("flow.run", name),
    onStopRun: (id) => controller.runCommandArgs("flow.run.stop", id),
    onRetryRun: (id) => controller.runCommandArgs("flow.run.retry", id),
    onChooseWorkflowRepo: (name) => controller.runCommandArgs("flow.repo.choose", name),
    onChangeWorldDocument: (id, body) =>
      controller.runCommandArgs("wiki.edit", `${id} ${JSON.stringify(body)}`),
    onAttachWorldEditor: controller.attachWorldEditor,
    onRunCommand: (name, commandArgs) =>
      commandArgs === undefined
        ? controller.runCommand(name)
        : controller.runCommandArgs(name, commandArgs)
  }
  bound.set(controller, actions)
  return actions
}
