import { describe, expect, it } from "vitest"
import {
  approverLabel,
  CALLBACK_DATA_MAX_BYTES,
  callbackData,
  decision,
  isOwnPress,
  keyboard,
  parseCallbackData,
  token,
  webAppButton
} from "../src/telegram/Approval.ts"

const TOKEN = token("run-1/approve-deploy")
const NOW = 1_700_000_000_000

describe("token", () => {
  it("is deterministic, short, and colon-free", () => {
    expect(token("run-1/approve-deploy")).toBe(TOKEN)
    expect(TOKEN).not.toContain(":")
    expect(TOKEN.length).toBeLessThan(10)
  })

  it("separates different approvals", () => {
    expect(token("run-1/a")).not.toBe(token("run-1/b"))
  })

  // Reachable from JavaScript, where the parameter type is not enforced.
  // Hashing an absent id read `undefined.length` and raised a `TypeError`
  // naming a property rather than the argument; hashing an empty one handed
  // every miscalled prompt the same namespace, which is the collision the
  // token exists to prevent.
  it("refuses an id that is not a non-empty string", () => {
    expect(() => token(undefined as never)).toThrow(/must be a non-empty string/)
    expect(() => token(7 as never)).toThrow(/must be a non-empty string/)
    expect(() => token("")).toThrow(/must be a non-empty string/)
  })
})

describe("callbackData", () => {
  it("encodes each choice compactly", () => {
    expect(callbackData({ kind: "approve" }, "t")).toBe("sap:t:a")
    expect(callbackData({ kind: "reject" }, "t")).toBe("sap:t:d")
    expect(callbackData({ kind: "select", key: "opt" }, "t")).toBe("sap:t:s:opt")
  })

  it("round-trips through the parser", () => {
    expect(parseCallbackData("sap:t:a")).toEqual({ token: "t", kind: "approve" })
    expect(parseCallbackData("sap:t:d")).toEqual({ token: "t", kind: "reject" })
    expect(parseCallbackData("sap:t:s:opt")).toEqual({ token: "t", kind: "select", key: "opt" })
  })

  // An empty token stays legal: it encodes the prompt a spec with no token
  // asks for, which resolves for nobody. A non-string is a caller error, and
  // reading `.includes` off one raised a `TypeError` naming a method.
  it("refuses a token that is not a string and keeps the empty one", () => {
    expect(() => callbackData({ kind: "approve" }, undefined as never)).toThrow(/must be a string/)
    expect(() => callbackData({ kind: "approve" }, 7 as never)).toThrow(/must be a string/)
    expect(callbackData({ kind: "approve" }, "")).toBe("sap::a")
  })

  it("refuses a token or key containing the separator", () => {
    expect(() => callbackData({ kind: "approve" }, "a:b")).toThrow(/must not contain a colon/)
    expect(() => callbackData({ kind: "select", key: "a:b" }, "t")).toThrow(/contain no ":"/)
    expect(() => callbackData({ kind: "select", key: "" }, "t")).toThrow(/non-empty/)
  })

  // Telegram truncates or rejects over the limit, and a truncated button
  // resolves to nothing at all.
  it("refuses data over Telegram's 64-byte limit", () => {
    expect(() => callbackData({ kind: "select", key: "k".repeat(70) }, "t"))
      .toThrow(new RegExp(`${CALLBACK_DATA_MAX_BYTES}-byte limit`))
  })

  it("measures the limit in bytes, not characters", () => {
    expect(() => callbackData({ kind: "select", key: "é".repeat(31) }, "t")).toThrow(/byte limit/)
  })

  it("returns null for anything that is not ours", () => {
    expect(parseCallbackData(undefined)).toBeNull()
    expect(parseCallbackData(null)).toBeNull()
    expect(parseCallbackData(7 as unknown as string)).toBeNull()
    expect(parseCallbackData("other:t:a")).toBeNull()
    expect(parseCallbackData("sap:t")).toBeNull()
    expect(parseCallbackData("sap:t:z")).toBeNull()
    expect(parseCallbackData("sap:t:s")).toBeNull()
    expect(parseCallbackData("sap:t:s:")).toBeNull()
  })

  // The encoder cannot produce `sap:<tok>:a:<extra>`, so reading it as an
  // approval accepts a press nothing here built.
  it("refuses approve and reject data with trailing parts the encoder cannot emit", () => {
    expect(parseCallbackData("sap:t:a:extra")).toBeNull()
    expect(parseCallbackData("sap:t:d:extra")).toBeNull()
  })
})

describe("keyboard", () => {
  it("builds an approve and reject row", () => {
    expect(keyboard({ mode: "approve", token: "t" })).toEqual([[
      { text: "Approve", callback_data: "sap:t:a" },
      { text: "Reject", callback_data: "sap:t:d" }
    ]])
  })

  it("takes custom labels", () => {
    const rows = keyboard({ mode: "approve", token: "t", approveText: "Ship it", rejectText: "Hold" })
    expect(rows[0]?.map((button) => button.text)).toEqual(["Ship it", "Hold"])
  })

  it("builds one row per option in select mode", () => {
    expect(keyboard({ mode: "select", token: "t", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }))
      .toEqual([
        [{ text: "A", callback_data: "sap:t:s:a" }],
        [{ text: "B", callback_data: "sap:t:s:b" }]
      ])
  })

  it("refuses select mode with no options", () => {
    expect(() => keyboard({ mode: "select", token: "t" })).toThrow(/at least one option/)
    expect(() => keyboard({ mode: "select", token: "t", options: [] })).toThrow(/at least one option/)
  })

  it("appends a Mini App button and requires HTTPS for it", () => {
    const rows = keyboard({ mode: "approve", token: "t", miniAppUrl: "https://app.example/review" })
    expect(rows.at(-1)).toEqual([{ text: "Open review", web_app: { url: "https://app.example/review" } }])
    expect(() => webAppButton("x", "http://app.example")).toThrow(/https:\/\//)
    expect(() => webAppButton("x", "")).toThrow(/https:\/\//)
  })
})

describe("decision", () => {
  const spec = { mode: "approve" as const, token: TOKEN, allowedChatIds: [42] }
  const selectSpec = {
    mode: "select" as const,
    token: TOKEN,
    allowedChatIds: [42],
    options: [{ key: "a", label: "A" }]
  }
  const decided = (approved: boolean) => ({ _tag: "Decided", decision: expect.objectContaining({ approved }) })

  it.each(
    [
      [42, [42], true],
      ["42", [42], true],
      [42, ["42"], true],
      [7, [42], false],
      [undefined, [42], false],
      [42, undefined, false],
      [42, [], false],
      [42, [-100], false]
    ] as const
  )("authorizes the presser %s using %s", (id, allowedChatIds, authorized) => {
    const query = { data: keyboard(spec)[0]?.[0]?.callback_data, from: { id, username: "will" } }
    expect(decision(query, { ...spec, allowedChatIds }, NOW)).toEqual(
      authorized ? decided(true) : { _tag: "Ignored", reason: "unauthorized" }
    )
  })

  // An unauthorized press must leave the approval pending, never deny it.
  it("ignores a non-approver's reject press instead of rejecting", () => {
    const query = { data: callbackData({ kind: "reject" }, TOKEN), from: { id: 7 } }
    expect(decision(query, spec, NOW)).toEqual({ _tag: "Ignored", reason: "unauthorized" })
  })

  it("ignores an unlisted sender's selection even with valid callback data", () => {
    const query = { data: keyboard(selectSpec)[0]?.[0]?.callback_data, from: { id: 7 } }
    expect(decision(query, selectSpec, NOW)).toEqual({ _tag: "Ignored", reason: "unauthorized" })
  })

  it("approves this approval's own approve press", () => {
    const result = decision(
      { data: callbackData({ kind: "approve" }, TOKEN), from: { id: 42, username: "will" } },
      spec,
      NOW
    )
    expect(result).toEqual({
      _tag: "Decided",
      decision: { approved: true, note: null, decidedBy: "@will", decidedAt: new Date(NOW).toISOString() }
    })
  })

  it("rejects this approval's own reject press", () => {
    expect(decision({ data: callbackData({ kind: "reject" }, TOKEN), from: { id: 42 } }, spec, NOW))
      .toEqual({ _tag: "Decided", decision: expect.objectContaining({ approved: false, note: null }) })
  })

  // A press on a different prompt in the same chat must never resolve this one.
  it("ignores a press carrying another approval's token", () => {
    const foreign = decision({ data: callbackData({ kind: "reject" }, token("other")), from: { id: 42 } }, spec, NOW)
    expect(foreign).toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })

  it("ignores unrecognized data", () => {
    expect(decision({ data: "garbage", from: { id: 42 } }, spec, NOW))
      .toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
    expect(decision({}, spec, NOW)).toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })

  it("ignores a select press on an approve prompt", () => {
    expect(decision({ data: callbackData({ kind: "select", key: "a" }, TOKEN), from: { id: 42 } }, spec, NOW))
      .toEqual({ _tag: "Ignored", reason: "unknown-option" })
  })

  it("identifies the approver by username, then by id", () => {
    expect(approverLabel({ from: { username: "will" } })).toBe("@will")
    expect(approverLabel({ from: { id: 42 } })).toBe("42")
    expect(approverLabel({ from: { username: "", id: 42 } })).toBe("42")
    expect(approverLabel({ from: {} })).toBeNull()
    expect(approverLabel({})).toBeNull()
  })

  it("selects an offered key with this approval's token and an allowed sender", () => {
    expect(decision({ data: callbackData({ kind: "select", key: "a" }, TOKEN), from: { id: "42" } }, selectSpec, NOW))
      .toEqual({ _tag: "Decided", decision: { selected: "a", notes: null } })
  })

  // Each case keeps the other selection guards satisfied so one guard cannot
  // mask a missing check in another.
  it("ignores a selection with an unoffered key", () => {
    expect(decision({ data: callbackData({ kind: "select", key: "b" }, TOKEN), from: { id: "42" } }, selectSpec, NOW))
      .toEqual({ _tag: "Ignored", reason: "unknown-option" })
  })

  it("ignores a select press on a select prompt that offers no options", () => {
    const bare = { mode: "select" as const, token: TOKEN, allowedChatIds: [42] }
    expect(decision({ data: callbackData({ kind: "select", key: "a" }, TOKEN), from: { id: 42 } }, bare, NOW))
      .toEqual({ _tag: "Ignored", reason: "unknown-option" })
  })

  it("ignores an approve press on a select prompt", () => {
    expect(decision({ data: callbackData({ kind: "approve" }, TOKEN), from: { id: "42" } }, selectSpec, NOW))
      .toEqual({ _tag: "Ignored", reason: "unknown-option" })
  })

  it("ignores a selection carrying another approval's token", () => {
    expect(
      decision(
        { data: callbackData({ kind: "select", key: "a" }, token("other")), from: { id: "42" } },
        selectSpec,
        NOW
      )
    ).toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })

  it("recognizes its own press", () => {
    expect(isOwnPress({ data: callbackData({ kind: "approve" }, TOKEN) }, { mode: "approve", token: TOKEN })).toBe(true)
    expect(isOwnPress({ data: callbackData({ kind: "approve" }, "other") }, { mode: "approve", token: TOKEN }))
      .toBe(false)
    expect(isOwnPress({}, { mode: "approve", token: TOKEN })).toBe(false)
  })

  // Falling back to the empty string gave every tokenless prompt the same
  // namespace, so any tokenless press resolved any tokenless approval.
  it("never matches a spec with no token", () => {
    const press = { data: callbackData({ kind: "approve" }, ""), from: { id: 42 } }
    expect(decision(press, { mode: "approve", allowedChatIds: [42] }, NOW))
      .toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
    expect(isOwnPress(press, { mode: "approve" })).toBe(false)
    expect(isOwnPress(press, { mode: "approve", token: "" })).toBe(false)
  })

  it("keeps two tokenless prompts from resolving each other", () => {
    const first = { mode: "approve" } as const
    const second = { mode: "approve", allowedChatIds: [42] } as const
    const pressOnFirst = { data: keyboard(first)[0]?.[0]?.callback_data, from: { id: 42 } }
    expect(decision(pressOnFirst, second, NOW)).toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })

  it("ignores every press on a tokenless select prompt", () => {
    const spec = { mode: "select", allowedChatIds: [42], options: [{ key: "a", label: "A" }] } as const
    expect(decision({ data: keyboard(spec)[0]?.[0]?.callback_data, from: { id: 42 } }, spec, NOW))
      .toEqual({ _tag: "Ignored", reason: "foreign-prompt" })
  })
})
