/**
 * Block Kit button approvals: the buttons a prompt sends and the decision a
 * press produces. A press is untrusted data from anyone in the conversation,
 * so every case that is not an authorized press of an offered option must
 * leave the approval pending (`Ignored`), never reject it.
 */
import { describe, expect, it } from "vitest"
import * as Approval from "../src/slack/Approval.ts"

const TOKEN = Approval.token("run-1/approve-merge")
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0)

const press = (actionId: string, fields: Record<string, unknown> = {}) => ({
  type: "block_actions",
  team: { id: "T1" },
  user: { id: "UOWNER", team_id: "T1" },
  channel: { id: "D0OWNER" },
  container: { channel_id: "D0OWNER", message_ts: "1700000001.000200" },
  trigger_id: "trigger-1",
  actions: [{ action_id: actionId, value: "x" }],
  ...fields
})

const approveSpec: Approval.PromptSpec & { readonly mode: "approve" } = {
  mode: "approve",
  token: TOKEN,
  allowedUserIds: ["UOWNER"]
}

const selectSpec: Approval.PromptSpec & { readonly mode: "select" } = {
  mode: "select",
  token: TOKEN,
  allowedUserIds: ["UOWNER"],
  options: [{ key: "ship", label: "Ship" }, { key: "hold", label: "Hold" }]
}

describe("token and action ids", () => {
  it("derives a short, stable, colon-free token and refuses an empty id", () => {
    expect(TOKEN).toMatch(/^[0-9a-f]{16}$/)
    expect(Approval.token("run-1/approve-merge")).toBe(TOKEN)
    expect(Approval.token("run-2/approve-merge")).not.toBe(TOKEN)
    expect(() => Approval.token("")).toThrow(/non-empty/)
    expect(() => Approval.token(7 as never)).toThrow(/non-empty/)
  })

  it("round-trips every choice through its action id", () => {
    const approve = Approval.actionId({ kind: "approve" }, TOKEN)
    const reject = Approval.actionId({ kind: "reject" }, TOKEN)
    const select = Approval.actionId({ kind: "select", key: "ship" }, TOKEN)
    expect([approve, reject, select]).toEqual([`sap:${TOKEN}:a`, `sap:${TOKEN}:d`, `sap:${TOKEN}:s:ship`])
    expect(Approval.parseActionId(approve)).toEqual({ token: TOKEN, kind: "approve" })
    expect(Approval.parseActionId(reject)).toEqual({ token: TOKEN, kind: "reject" })
    expect(Approval.parseActionId(select)).toEqual({ token: TOKEN, kind: "select", key: "ship" })
  })

  it("refuses ids it could not have produced", () => {
    expect(() => Approval.actionId({ kind: "approve" }, "a:b")).toThrow(/colon/)
    expect(() => Approval.actionId({ kind: "select", key: "" }, TOKEN)).toThrow(/option key/)
    expect(() => Approval.actionId({ kind: "select", key: "a:b" }, TOKEN)).toThrow(/option key/)
    expect(() => Approval.actionId({ kind: "select", key: "k".repeat(Approval.ACTION_ID_MAX_LENGTH) }, TOKEN))
      .toThrow(/255/)
    for (const value of [7, "other:t:a", "sap:t", "sap:t:x", "sap:t:s:", "sap:t:s", "sap:t:a:extra"]) {
      expect(Approval.parseActionId(value)).toBeNull()
    }
  })
})

describe("blocks", () => {
  it("offers approve and reject buttons namespaced by the token", () => {
    expect(Approval.blocks({ ...approveSpec, approveText: "Merge", rejectText: "Stop" })).toEqual([{
      type: "actions",
      block_id: `sap:${TOKEN}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Merge" },
          action_id: `sap:${TOKEN}:a`,
          value: "approve",
          style: "primary"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          action_id: `sap:${TOKEN}:d`,
          value: "reject",
          style: "danger"
        }
      ]
    }])
    expect(Approval.blocks(approveSpec)[0]).toMatchObject({
      elements: [{ text: { text: "Approve" } }, { text: { text: "Reject" } }]
    })
  })

  it("offers one button per option in select mode, and refuses select mode without options", () => {
    const [block] = Approval.blocks(selectSpec) as ReadonlyArray<{ elements: ReadonlyArray<unknown> }>
    expect(block?.elements).toEqual([
      { type: "button", text: { type: "plain_text", text: "Ship" }, action_id: `sap:${TOKEN}:s:ship`, value: "ship" },
      { type: "button", text: { type: "plain_text", text: "Hold" }, action_id: `sap:${TOKEN}:s:hold`, value: "hold" }
    ])
    expect(() => Approval.blocks({ mode: "select", token: TOKEN })).toThrow(/at least one option/)
  })

  it("builds a prompt without a token that matches no press", () => {
    const [block] = Approval.blocks({ mode: "approve" }) as ReadonlyArray<{ block_id: string }>
    expect(block?.block_id).toBe("sap:")
    expect(Approval.decision(press("sap::a"), { mode: "approve", allowedUserIds: ["UOWNER"] }, NOW))
      .toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
    expect(Approval.decision(press("sap::a"), { mode: "approve", token: "", allowedUserIds: ["UOWNER"] }, NOW))
      .toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })
})

describe("decision", () => {
  it("decides on the owner's press, recording who and when", () => {
    expect(Approval.decision(press(`sap:${TOKEN}:a`), approveSpec, NOW)).toEqual({
      _tag: "Decided",
      decision: { approved: true, note: null, decidedBy: "UOWNER", decidedAt: "2026-09-25T12:00:00.000Z" }
    })
    expect(Approval.decision(press(`sap:${TOKEN}:d`), approveSpec, NOW)).toMatchObject({
      _tag: "Decided",
      decision: { approved: false }
    })
    const decided = Approval.decision(press(`sap:${TOKEN}:a`), approveSpec)
    expect(decided._tag === "Decided" && Date.parse(decided.decision.decidedAt) > 0).toBe(true)
  })

  it("ignores anyone else's press, and every press when nobody is allowed", () => {
    const stranger = press(`sap:${TOKEN}:a`, { user: { id: "UOTHER", team_id: "T1" } })
    expect(Approval.decision(stranger, approveSpec, NOW)).toEqual({ _tag: "Ignored", reason: "unauthorized" })
    expect(Approval.decision(press(`sap:${TOKEN}:a`), { mode: "approve", token: TOKEN }, NOW))
      .toEqual({ _tag: "Ignored", reason: "unauthorized" })
  })

  it("checks the workspace when the prompt names workspaces", () => {
    const spec = { ...approveSpec, allowedTeamIds: ["T1"] }
    expect(Approval.decision(press(`sap:${TOKEN}:a`), spec, NOW)._tag).toBe("Decided")
    expect(Approval.decision(press(`sap:${TOKEN}:a`, { team: null }), spec, NOW)._tag).toBe("Decided")
    expect(Approval.decision(press(`sap:${TOKEN}:a`, { team: { id: "T2" } }), spec, NOW))
      .toEqual({ _tag: "Ignored", reason: "unauthorized" })
    expect(Approval.decision(press(`sap:${TOKEN}:a`, { team: null, user: { id: "UOWNER" } }), spec, NOW))
      .toEqual({ _tag: "Ignored", reason: "unauthorized" })
  })

  it("ignores malformed payloads and presses on another prompt", () => {
    const foreign = { _tag: "Ignored", reason: "foreign-prompt" }
    expect(Approval.decision({ type: "message" }, approveSpec, NOW)).toEqual(foreign)
    expect(Approval.decision(press(`sap:${TOKEN}:a`, { actions: [] }), approveSpec, NOW)).toEqual(foreign)
    const two = [{ action_id: `sap:${TOKEN}:a` }, { action_id: `sap:${TOKEN}:d` }]
    expect(Approval.decision(press(`sap:${TOKEN}:a`, { actions: two }), approveSpec, NOW)).toEqual(foreign)
    expect(Approval.decision(press("not-an-approval"), approveSpec, NOW)).toEqual(foreign)
    expect(Approval.decision(press(`sap:${Approval.token("other")}:a`), approveSpec, NOW)).toEqual(foreign)
  })

  it("decides a select press of an offered option only", () => {
    expect(Approval.decision(press(`sap:${TOKEN}:s:ship`), selectSpec, NOW)).toEqual({
      _tag: "Decided",
      decision: { selected: "ship", notes: null, decidedBy: "UOWNER", decidedAt: "2026-09-25T12:00:00.000Z" }
    })
    const unknown = { _tag: "Ignored", reason: "unknown-option" }
    expect(Approval.decision(press(`sap:${TOKEN}:s:burn`), selectSpec, NOW)).toEqual(unknown)
    expect(Approval.decision(press(`sap:${TOKEN}:a`), selectSpec, NOW)).toEqual(unknown)
    expect(Approval.decision(press(`sap:${TOKEN}:s:ship`), { ...selectSpec, options: undefined }, NOW))
      .toEqual(unknown)
    expect(Approval.decision(press(`sap:${TOKEN}:s:ship`), approveSpec, NOW)).toEqual(unknown)
  })
})

describe("pressedToken", () => {
  it("names the prompt a single approval press belongs to, and nothing else", () => {
    expect(Approval.pressedToken(press(`sap:${TOKEN}:a`))).toBe(TOKEN)
    expect(Approval.pressedToken(press(`sap:${TOKEN}:s:ship`))).toBe(TOKEN)
    expect(Approval.pressedToken(press("not-an-approval"))).toBeNull()
    expect(Approval.pressedToken(press(`sap:${TOKEN}:a`, { actions: [] }))).toBeNull()
    expect(Approval.pressedToken({ type: "message" })).toBeNull()
  })
})
