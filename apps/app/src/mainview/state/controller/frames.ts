import {
  cardFrameId,
  DEFAULT_BRANCH_ID,
  DEFAULT_WORKSPACE_ID,
  rootFrameId
} from "../AppState"
import type { Branch, Frame, FrameSnapshot } from "../AppState"
import type { FrameHistoryPort, FrameLocation } from "../../runtime/FrameHistory"
import type { ControllerContext } from "./context"

export interface FramesController {
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly frameBack: () => void
  readonly frameForward: () => void
  readonly forkFrame: () => string | void
}

const sessionLocation = (ctx: ControllerContext): FrameLocation => {
  const session = ctx.store.session()
  const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
  return {
    workspaceId: session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID,
    branchId,
    frameId: session.activeFrameId ?? rootFrameId(branchId)
  }
}

const validLocation = (ctx: ControllerContext, location: FrameLocation): boolean => {
  const workspace = ctx.store.collections.workspaces.get(location.workspaceId)
  const branch = ctx.store.collections.branches.get(location.branchId)
  const frame = ctx.store.collections.frames.get(location.frameId)
  return workspace !== undefined &&
    branch?.workspaceId === workspace.id &&
    frame?.workspaceId === workspace.id &&
    frame.branchId === branch.id &&
    (frame.cardId === null || ctx.store.collections.cards.get(frame.cardId) !== undefined ||
      branch.snapshot?.cards.some((card) => card.id === frame.cardId) === true)
}

const sameLocation = (left: FrameLocation, right: FrameLocation): boolean =>
  left.workspaceId === right.workspaceId && left.branchId === right.branchId && left.frameId === right.frameId

export const createFramesController = (
  ctx: ControllerContext,
  history: FrameHistoryPort | undefined
): FramesController => {
  const navigateFromHistory = (location: FrameLocation | undefined): void => {
    if (location !== undefined && location.branchId !== sessionLocation(ctx).branchId && ctx.store.session().phase === "responding") {
      history?.replace(sessionLocation(ctx))
      return
    }
    if (location === undefined || !validLocation(ctx, location)) {
      history?.replace(sessionLocation(ctx))
      return
    }
    if (sameLocation(location, sessionLocation(ctx))) return
    ctx.store.dispatch({ type: "frame.navigated", actor: "system", ...location })
  }

  if (history !== undefined) {
    const initial = history.current()
    if (initial !== undefined && validLocation(ctx, initial)) navigateFromHistory(initial)
    else history.replace(sessionLocation(ctx))
    ctx.onDispose(history.subscribe(navigateFromHistory))
  }

  const maximizeCard: FramesController["maximizeCard"] = (id) => {
    if (ctx.store.collections.cards.get(id) === undefined) return `There is no card with id ${id}.`
    const session = ctx.store.session()
    const workspaceId = session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
    const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
    ctx.store.dispatch({ type: "card.maximized", actor: "user", id })
    history?.push({ workspaceId, branchId, frameId: cardFrameId(branchId, id) })
  }

  const minimizeCard = (): void => {
    const session = ctx.store.session()
    const workspaceId = session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
    const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
    ctx.store.dispatch({ type: "card.minimized", actor: "user" })
    history?.push({ workspaceId, branchId, frameId: rootFrameId(branchId) })
  }

  const forkFrame = (): string | void => {
    if (ctx.store.session().phase === "responding") return "Wait for the current turn to finish before forking."
    const sourceLocation = sessionLocation(ctx)
    const source = ctx.store.collections.frames.get(sourceLocation.frameId)
    if (source === undefined) return "The current frame no longer exists."
    const id = `branch-${crypto.randomUUID()}`
    const rootId = rootFrameId(id)
    const createdAt = Date.now()
    const revision = ctx.store.session().revision + 1
    // Historical frames keep their recorded state; the live collections are
    // only the active branch's projection, never an authority for another branch.
    const snapshot: FrameSnapshot = source.snapshot ?? {
      revision: ctx.store.session().revision,
      messages: [...ctx.store.collections.messages.values()],
      cards: [...ctx.store.collections.cards.values()],
      worldDocuments: [...ctx.store.collections.worldDocuments.values()],
      draft: ctx.store.session().draft,
      selectedWorldDocumentId: ctx.store.session().selectedWorldDocumentId
    }
    const branch: Branch = {
      id,
      workspaceId: source.workspaceId,
      title: `Fork ${ctx.store.collections.branches.size}`,
      parentBranchId: source.branchId,
      forkedFromFrameId: source.id,
      forkedAtRevision: snapshot.revision,
      snapshot,
      createdAt,
      revision
    }
    const rootFrame: Frame = {
      id: rootId,
      workspaceId: source.workspaceId,
      branchId: id,
      kind: "root",
      parentFrameId: null,
      cardId: null,
      presentation: "embedded",
      stateRevision: snapshot.revision,
      snapshot,
      createdAt,
      updatedAt: createdAt,
      revision
    }
    const selectedFrame: Frame = source.kind === "root"
      ? rootFrame
      : {
        id: cardFrameId(id, source.cardId!),
        workspaceId: source.workspaceId,
        branchId: id,
        kind: "card",
        parentFrameId: rootId,
        cardId: source.cardId,
        presentation: "maximized",
        stateRevision: snapshot.revision,
        snapshot,
        createdAt,
        updatedAt: createdAt,
        revision
      }
    ctx.store.dispatch({ type: "frame.forked", actor: "user", branch, rootFrame, selectedFrame })
    history?.push({ workspaceId: source.workspaceId, branchId: id, frameId: selectedFrame.id })
  }

  return {
    maximizeCard,
    minimizeCard,
    frameBack: () => history?.back(),
    frameForward: () => history?.forward(),
    forkFrame
  }
}
