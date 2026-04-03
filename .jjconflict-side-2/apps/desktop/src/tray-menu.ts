import type { BurnsTrayStatus } from "@burns/shared"

export const OPEN_BURNS_TRAY_ACTION = "open-burns"
export const PENDING_TRAY_ACTION = "open-pending"
export const RUNNING_TRAY_ACTION = "open-running"
export const EXIT_TRAY_ACTION = "exit-and-stop-server"

export type TrayMenuItem =
  | { type: "divider" }
  | {
      type: "normal"
      label: string
      action: string
      enabled?: boolean
    }

export type TrayActionOutcome =
  | {
      kind: "none"
    }
  | {
      kind: "open-window"
      path: string | null
    }
  | {
      kind: "quit"
    }

export function buildTrayMenu(trayStatus: BurnsTrayStatus): TrayMenuItem[] {
  return [
    {
      type: "normal",
      label: "Open Burns",
      action: OPEN_BURNS_TRAY_ACTION,
    },
    {
      type: "divider",
    },
    {
      type: "normal",
      label: `Pending: ${trayStatus.pendingCount}`,
      action: PENDING_TRAY_ACTION,
      enabled: trayStatus.pendingCount > 0,
    },
    {
      type: "normal",
      label: `Running: ${trayStatus.runningCount}`,
      action: RUNNING_TRAY_ACTION,
      enabled: trayStatus.runningCount > 0,
    },
    {
      type: "divider",
    },
    {
      type: "normal",
      label: "Exit (Stop Server)",
      action: EXIT_TRAY_ACTION,
    },
  ]
}

export function resolveTrayActionOutcome(
  action: string,
  trayStatus: BurnsTrayStatus
): TrayActionOutcome {
  if (action === EXIT_TRAY_ACTION) {
    return {
      kind: "quit",
    }
  }

  if (action === OPEN_BURNS_TRAY_ACTION) {
    return {
      kind: "open-window",
      path: null,
    }
  }

  if (action === RUNNING_TRAY_ACTION) {
    return trayStatus.runningCount > 0
      ? {
          kind: "open-window",
          path: null,
        }
      : {
          kind: "none",
        }
  }

  if (action === PENDING_TRAY_ACTION) {
    if (trayStatus.pendingCount === 0 || !trayStatus.pendingTarget) {
      return {
        kind: "none",
      }
    }

    if (trayStatus.pendingTarget.kind === "inbox") {
      return {
        kind: "open-window",
        path: "/inbox",
      }
    }

    return {
      kind: "open-window",
      path: `/w/${trayStatus.pendingTarget.workspaceId}/runs/${trayStatus.pendingTarget.runId}`,
    }
  }

  return {
    kind: "none",
  }
}
