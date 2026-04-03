import { describe, expect, it } from "bun:test"

import type { BurnsTrayStatus } from "@burns/shared"

import {
  OPEN_BURNS_TRAY_ACTION,
  EXIT_TRAY_ACTION,
  PENDING_TRAY_ACTION,
  RUNNING_TRAY_ACTION,
  buildTrayMenu,
  resolveTrayActionOutcome,
} from "./tray-menu"

function buildTrayStatus(overrides: Partial<BurnsTrayStatus> = {}): BurnsTrayStatus {
  return {
    pendingCount: 0,
    runningCount: 0,
    pendingTarget: null,
    ...overrides,
  }
}

describe("tray menu", () => {
  it("builds the expected menu structure", () => {
    const menu = buildTrayMenu(
      buildTrayStatus({
        pendingCount: 1,
        runningCount: 2,
      })
    )

    expect(menu).toEqual([
      { type: "normal", label: "Open Burns", action: OPEN_BURNS_TRAY_ACTION },
      { type: "divider" },
      { type: "normal", label: "Pending: 1", action: PENDING_TRAY_ACTION, enabled: true },
      { type: "normal", label: "Running: 2", action: RUNNING_TRAY_ACTION, enabled: true },
      { type: "divider" },
      { type: "normal", label: "Exit (Stop Server)", action: EXIT_TRAY_ACTION },
    ])
  })

  it("disables pending and running rows when their counts are zero", () => {
    const menu = buildTrayMenu(buildTrayStatus())

    expect(menu).toEqual([
      { type: "normal", label: "Open Burns", action: OPEN_BURNS_TRAY_ACTION },
      { type: "divider" },
      { type: "normal", label: "Pending: 0", action: PENDING_TRAY_ACTION, enabled: false },
      { type: "normal", label: "Running: 0", action: RUNNING_TRAY_ACTION, enabled: false },
      { type: "divider" },
      { type: "normal", label: "Exit (Stop Server)", action: EXIT_TRAY_ACTION },
    ])
  })

  it("opens the inbox when pending count is greater than one", () => {
    const outcome = resolveTrayActionOutcome(
      PENDING_TRAY_ACTION,
      buildTrayStatus({
        pendingCount: 2,
        pendingTarget: { kind: "inbox" },
      })
    )

    expect(outcome).toEqual({
      kind: "open-window",
      path: "/inbox",
    })
  })

  it("opens the run detail when exactly one pending target exists", () => {
    const outcome = resolveTrayActionOutcome(
      PENDING_TRAY_ACTION,
      buildTrayStatus({
        pendingCount: 1,
        pendingTarget: {
          kind: "run",
          workspaceId: "workspace-1",
          runId: "run-1",
        },
      })
    )

    expect(outcome).toEqual({
      kind: "open-window",
      path: "/w/workspace-1/runs/run-1",
    })
  })

  it("opens Burns without changing routes for running and open actions", () => {
    expect(resolveTrayActionOutcome(OPEN_BURNS_TRAY_ACTION, buildTrayStatus())).toEqual({
      kind: "open-window",
      path: null,
    })

    expect(
      resolveTrayActionOutcome(
        RUNNING_TRAY_ACTION,
        buildTrayStatus({
          runningCount: 2,
        })
      )
    ).toEqual({
      kind: "open-window",
      path: null,
    })
  })

  it("returns no-op for disabled status rows and quit for exit", () => {
    expect(resolveTrayActionOutcome(PENDING_TRAY_ACTION, buildTrayStatus())).toEqual({
      kind: "none",
    })

    expect(resolveTrayActionOutcome(RUNNING_TRAY_ACTION, buildTrayStatus())).toEqual({
      kind: "none",
    })

    expect(resolveTrayActionOutcome(EXIT_TRAY_ACTION, buildTrayStatus())).toEqual({
      kind: "quit",
    })
  })
})
