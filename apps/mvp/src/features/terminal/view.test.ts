// What the Terminal view shows (src/features/terminal/view.ts, docs/features/branch-workspace.md#the-page).
import { describe, expect, test } from "vitest"
import type { Panel, Tab } from "./schema"
import { NO_TERMINALS, panelViewOf, WAITING_FOR_SANDBOX } from "./view"

const panel = (fields: Partial<Panel> = {}): Panel => ({
  id: "panel",
  branchId: "b-1",
  terminalId: null,
  phase: "idle",
  access: null,
  ...fields,
})

const tab = (fields: Partial<Tab> = {}): Tab => ({
  id: "t-1",
  ownerId: "maya",
  ownerLogin: "maya",
  mine: false,
  status: "open",
  waiting: false,
  createdAt: "2026-10-20T12:00:00Z",
  ...fields,
})

describe("panelViewOf", () => {
  test("nothing for a page that shows no branch yet", () => {
    expect(panelViewOf(undefined, [], true)).toBeUndefined()
    expect(panelViewOf(panel({ branchId: null }), [], true)).toBeUndefined()
  })

  test("unknown rows keep the screen with neither Open terminal nor No terminals, even with previous tabs", () => {
    for (const canOpen of [true, false]) {
      expect(panelViewOf(panel({ phase: "loading" }), [tab()], canOpen)).toEqual({
        badge: undefined, open: undefined, screen: { kind: "empty", text: undefined },
      })
    }
  })

  // The branch terminal's recordings showed a small button over a blank page, then seconds of nothing while the
  // machine woke (Will, 2026-10-20): the screen is always there, with Open terminal in its middle.
  test("an editor without a terminal gets Open terminal in the screen; disabled with a spinner while the machine wakes", () => {
    expect(panelViewOf(panel(), [], true)).toEqual({ badge: undefined, open: "button", screen: { kind: "open" } })
    expect(panelViewOf(panel({ phase: "opening", terminalId: "t-9" }), [], true)).toEqual({
      badge: undefined,
      open: "opening",
      screen: { kind: "open" },
    })
    // Their terminal is still opening in the tabs: the button stays, disabled, until it attaches.
    expect(panelViewOf(panel({ phase: "opening" }), [tab({ mine: true, status: "opening" })], true)!.open).toBe("opening")
    // A terminal that failed to open, or ended, offers Open terminal again, under its badge.
    expect(panelViewOf(panel({ phase: "failed" }), [], true)).toEqual({ badge: undefined, open: "button", screen: { kind: "open" } })
    expect(panelViewOf(panel({ phase: "ended", terminalId: "t-1" }), [], true)).toEqual({
      badge: "Ended",
      open: "button",
      screen: { kind: "open" },
    })
  })

  test("a terminal waiting for a free machine keeps the button disabled and says Waiting for a sandbox", () => {
    const waiting = tab({ id: "t-9", mine: true, status: "opening", waiting: true })
    expect(panelViewOf(panel({ phase: "opening", terminalId: "t-9" }), [waiting], true)).toEqual({
      badge: undefined,
      open: "waiting",
      screen: { kind: "open" },
    })
    expect(WAITING_FOR_SANDBOX).toBe("Waiting for a sandbox")
    // Another person's waiting terminal says nothing about this person's.
    expect(panelViewOf(panel({ phase: "opening", terminalId: "t-1" }), [{ ...waiting, mine: false }], true)!.open).toBe("opening")
  })

  // A run that died left the person's row `opening` for good: the panel gave up on it (`failed` after the deadline),
  // and its tab, still theirs, hid Open terminal, so the view showed neither a frame nor the button. ChatApi fails such
  // a row on the next open (worker/branch/Terminals.ts `admit`), so the button comes back.
  test("Open terminal comes back for a terminal the panel gave up on while its row still says opening", () => {
    const stuck = tab({ id: "t-1", mine: true, status: "opening" })
    expect(panelViewOf(panel({ phase: "failed", terminalId: "t-1" }), [stuck], true)).toEqual({
      badge: undefined,
      open: "button",
      screen: { kind: "open" },
    })
    // Another live terminal of theirs still hides it: they have one.
    expect(panelViewOf(panel({ phase: "failed", terminalId: "t-1" }), [tab({ id: "t-2", mine: true })], true)!.open)
      .toBeUndefined()
  })

  test("an attached terminal fills the screen, read-only for a viewer; Open terminal moves above it", () => {
    expect(panelViewOf(panel({ phase: "open", terminalId: "t-1", access: "write" }), [tab({ mine: true })], true)).toEqual({
      badge: undefined,
      open: undefined,
      screen: { kind: "frame", terminalId: "t-1", readOnly: false },
    })
    expect(panelViewOf(panel({ phase: "connecting", terminalId: "t-1" }), [tab()], false)).toEqual({
      badge: undefined,
      open: undefined,
      screen: { kind: "frame", terminalId: "t-1", readOnly: false },
    })
    expect(panelViewOf(panel({ phase: "offline", terminalId: "t-1", access: "read" }), [tab()], false)).toEqual({
      badge: "Offline",
      open: undefined,
      screen: { kind: "frame", terminalId: "t-1", readOnly: true },
    })
    // An editor watching someone else's terminal can still open their own.
    expect(panelViewOf(panel({ phase: "open", terminalId: "t-1", access: "write" }), [tab()], true)!.open).toBe("button")
  })

  test("a failed panel offers Open terminal even while the person's tab is still opening", () => {
    const failed = panel({ phase: "failed", terminalId: "t-1" })
    const tabs = [tab({ mine: true, status: "opening" })]
    expect(panelViewOf(failed, tabs, true)).toEqual({ badge: undefined, open: "button", screen: { kind: "open" } })
    expect(panelViewOf(failed, tabs, false)).toEqual({ badge: undefined, open: undefined, screen: { kind: "empty", text: undefined } })
  })

  test("someone who can't open a terminal sees No terminals on a branch with none, and only the badge otherwise", () => {
    expect(panelViewOf(panel(), [], false)).toEqual({
      badge: undefined,
      open: undefined,
      screen: { kind: "empty", text: NO_TERMINALS },
    })
    expect(panelViewOf(panel({ phase: "no_access", terminalId: "t-1" }), [], false)).toEqual({
      badge: "No access",
      open: undefined,
      screen: { kind: "empty", text: undefined },
    })
    // Live terminals to pick from in the tabs: the screen waits for one, without saying there are none.
    expect(panelViewOf(panel({ phase: "failed" }), [tab()], false)!.screen).toEqual({ kind: "empty", text: undefined })
  })
})

test("a machine refusal explains membership and never offers another open", () => {
  expect(panelViewOf(panel({ phase: "members_only" }), [], true)).toEqual({
    badge: "Members can run machines.", open: undefined, screen: { kind: "empty", text: undefined },
  })
})
