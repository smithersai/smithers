/**
 * The admission policy and event decoding both Slack doors share.
 *
 * Every refusal reason is driven by a payload shaped the way Slack delivers
 * it, because the policy is the whole of what keeps another workspace, an
 * unlisted channel, or the app's own message from reaching a flow.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ExternalEvent from "../src/core/ExternalEvent.ts"
import * as Payload from "../src/slack/Payload.ts"

const policy: Payload.Policy = { allowedTeamIds: ["T1"], allowedChannelIds: ["C1", "D1"] }

const callback = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  token: "legacy-verification-token",
  team_id: "T1",
  api_app_id: "A1",
  type: "event_callback",
  event_id: "Ev1",
  event_time: 1_700_000_000,
  authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }, { team_id: "T1", is_bot: false }],
  event,
  ...extra
})

const message = (fields: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text: "hello",
  ts: "1700000000.000100",
  event_ts: "1700000000.000100",
  ...fields
})

const press = (fields: Record<string, unknown> = {}) => ({
  type: "block_actions",
  token: "legacy-verification-token",
  response_url: "https://hooks.example.test/actions/secret",
  team: { id: "T1", domain: "example" },
  user: { id: "U1", team_id: "T1" },
  channel: { id: "C1" },
  container: { type: "message", channel_id: "C1", message_ts: "1700000000.000100" },
  trigger_id: "trigger-1",
  actions: [{ action_id: "sap:t:a", value: "approve", action_ts: "1700000001.000000" }],
  ...fields
})

describe("schemas", () => {
  it("decode the shapes Slack delivers and keep unmodelled fields", () => {
    expect(Schema.decodeUnknownSync(Payload.EventCallback)(callback(message()))).toMatchObject({ event_id: "Ev1" })
    expect(Schema.decodeUnknownSync(Payload.MessageEvent)(message({ extra: 1 }))).toMatchObject({ extra: 1 })
    expect(Schema.decodeUnknownSync(Payload.BlockActions)(press())).toMatchObject({ trigger_id: "trigger-1" })
    expect(Schema.is(Payload.UrlVerification)({ type: "url_verification", challenge: "c" })).toBe(true)
    expect(Schema.is(Payload.SocketEnvelope)({ type: "hello" })).toBe(true)
    expect(Schema.is(Payload.Message)({ ts: "1.2", edited: { ts: "1.3" } })).toBe(true)
    expect(Schema.is(Payload.Ts)("1700000000.000100")).toBe(true)
    expect(Schema.is(Payload.Ts)("1700000000")).toBe(false)
    expect(Schema.is(Payload.ChannelId)("C0123ABC")).toBe(true)
    expect(Schema.is(Payload.ChannelId)("#general")).toBe(false)
    expect(Schema.is(Payload.Authorization)({ user_id: "U", is_bot: true, team_id: null })).toBe(true)
  })
})

describe("requirePolicy", () => {
  it("returns a policy with two non-empty allowlists", () => {
    expect(Payload.requirePolicy(policy, "test")).toBe(policy)
  })

  it("refuses a missing, empty, or malformed allowlist", () => {
    expect(() => Payload.requirePolicy(undefined as never, "door")).toThrow(/door requires non-empty/)
    expect(() => Payload.requirePolicy({ allowedTeamIds: [], allowedChannelIds: ["C1"] }, "door")).toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedChannelIds: [] }, "door")).toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: [""], allowedChannelIds: ["C1"] }, "door")).toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: "T1" as never, allowedChannelIds: ["C1"] }, "door"))
      .toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedUserIds: [] }, "door")).toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedUserIds: [""] }, "door")).toThrow()
    expect(() => Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedUserIds: "U1" as never }, "door")).toThrow()
    expect(() =>
      Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedChannelIds: [""], allowedUserIds: ["U1"] }, "door")
    ).toThrow()
    expect(() =>
      Payload.requirePolicy({ allowedTeamIds: ["T1"], allowedUserIds: ["U1"], selfUserIds: [7] as never }, "door")
    ).toThrow()
  })

  it("accepts people in place of conversations", () => {
    const people: Payload.Policy = { allowedTeamIds: ["T1"], allowedUserIds: ["U1"] }
    expect(Payload.requirePolicy(people, "door")).toBe(people)
  })
})

describe("classify", () => {
  const verdict = (payload: unknown, override: Partial<Payload.Policy> = {}) =>
    Payload.classify(payload, { ...policy, ...override })

  it("admits a person's message in an allowed channel of an allowed workspace", () => {
    expect(verdict(callback(message()))).toEqual({
      _tag: "Admitted",
      teamId: "T1",
      channelId: "C1",
      key: "slack:T1:Ev1",
      names: ["integration:slack:message"]
    })
  })

  it("refuses what it cannot name or deduplicate", () => {
    expect(verdict({ type: "url_verification", challenge: "c" })).toEqual({ _tag: "Refused", reason: "unsupported" })
    expect(verdict("text")).toEqual({ _tag: "Refused", reason: "unsupported" })
    expect(verdict(callback({ type: "odd:type", channel: "C1" }))._tag).toBe("Refused")
    expect(verdict(press({ trigger_id: undefined }))).toEqual({ _tag: "Refused", reason: "unsupported" })
  })

  it("refuses another workspace", () => {
    expect(verdict(callback(message(), { team_id: "T2" }))).toEqual({ _tag: "Refused", reason: "team-not-allowed" })
  })

  it("refuses an unlisted channel, and a delivery that names none", () => {
    expect(verdict(callback(message({ channel: "C9" })))).toEqual({ _tag: "Refused", reason: "channel-not-allowed" })
    expect(verdict(callback({ type: "team_join", user: { id: "U2" } })))
      .toEqual({ _tag: "Refused", reason: "channel-not-allowed" })
    expect(verdict(callback({ type: "channel_rename", channel: { id: "C1" } })))
      .toEqual({ _tag: "Refused", reason: "channel-not-allowed" })
  })

  it("reads the channel of a reaction from its item", () => {
    const reaction = { type: "reaction_added", user: "U1", reaction: "eyes", item: { type: "message", channel: "C1" } }
    expect(verdict(callback(reaction))).toMatchObject({ _tag: "Admitted", channelId: "C1" })
    expect(verdict(callback({ ...reaction, item: "C1" }))).toMatchObject({ reason: "channel-not-allowed" })
  })

  it("refuses a bot's message, however Slack marks it", () => {
    expect(verdict(callback(message({ bot_id: "B1" })))).toEqual({ _tag: "Refused", reason: "bot-author" })
    expect(verdict(callback(message({ subtype: "bot_message", user: undefined }))))
      .toEqual({ _tag: "Refused", reason: "bot-author" })
  })

  it("refuses the app's own messages: the installed bot user and any configured self id", () => {
    expect(verdict(callback(message({ user: "UBOT" })))).toEqual({ _tag: "Refused", reason: "self-author" })
    expect(verdict(callback(message({ user: "U7" })), { selfUserIds: ["U7"] }))
      .toEqual({ _tag: "Refused", reason: "self-author" })
    expect(verdict(callback(message({ user: "U7" }), { authorizations: undefined })))
      .toMatchObject({ _tag: "Admitted" })
  })

  it("judges an edit or a deletion by the message it changes", () => {
    const edited = message({
      subtype: "message_changed",
      user: undefined,
      message: {
        type: "message",
        user: "U1",
        text: "new",
        ts: "1700000000.000100",
        edited: { ts: "1700000005.000000" }
      }
    })
    expect(verdict(callback(edited))).toMatchObject({
      _tag: "Admitted",
      names: ["integration:slack:message.message_changed", "integration:slack:message"]
    })
    expect(verdict(callback({ ...edited, message: { ts: "1700000000.000100", bot_id: "B1" } })))
      .toMatchObject({ reason: "bot-author" })
    const deleted = message({
      subtype: "message_deleted",
      user: undefined,
      deleted_ts: "1700000000.000100",
      previous_message: { user: "UBOT", ts: "1700000000.000100" }
    })
    expect(verdict(callback(deleted))).toMatchObject({ reason: "self-author" })
    expect(verdict(callback({ ...deleted, previous_message: undefined }))).toMatchObject({ _tag: "Admitted" })
  })

  it("names only the base type when the subtype is not a signal segment", () => {
    expect(verdict(callback(message({ subtype: "odd:subtype" })))).toMatchObject({
      names: ["integration:slack:message"]
    })
  })

  it("admits a person's button press, reading its workspace and channel wherever Slack put them", () => {
    expect(verdict(press())).toEqual({
      _tag: "Admitted",
      teamId: "T1",
      channelId: "C1",
      key: "slack:T1:action:trigger-1",
      names: ["integration:slack:block_actions"]
    })
    expect(verdict(press({ team: null, channel: undefined }))).toMatchObject({ _tag: "Admitted", teamId: "T1" })
    expect(verdict(press({ team: null, user: { id: "U1" } }))).toMatchObject({ reason: "team-not-allowed" })
    expect(verdict(press({ channel: undefined, container: undefined }))).toMatchObject({
      reason: "channel-not-allowed"
    })
    expect(verdict(press({ user: { id: "U7", team_id: "T1" } }), { selfUserIds: ["U7"] }))
      .toMatchObject({ reason: "self-author" })
  })

  describe("with allowedUserIds", () => {
    const owner: Payload.Policy = { allowedTeamIds: ["T1"], allowedUserIds: ["UOWNER"] }
    const dm = (fields: Record<string, unknown> = {}) =>
      callback(message({ channel: "D0OWNER", channel_type: "im", user: "UOWNER", ...fields }))

    it("admits the owner's direct message before its conversation is listed", () => {
      expect(Payload.isDirectMessage("D0OWNER")).toBe(true)
      expect(Payload.isDirectMessage("C1")).toBe(false)
      expect(Payload.classify(dm(), owner)).toMatchObject({ _tag: "Admitted", channelId: "D0OWNER" })
      expect(Payload.classify(press({ user: { id: "UOWNER" }, channel: { id: "D0OWNER" } }), owner))
        .toMatchObject({ _tag: "Admitted", channelId: "D0OWNER" })
    })

    it("refuses anyone else, and an unlisted channel even for the owner", () => {
      expect(Payload.classify(dm({ user: "U2" }), owner)).toEqual({ _tag: "Refused", reason: "user-not-allowed" })
      expect(Payload.classify(dm({ user: undefined }), owner)).toMatchObject({ reason: "user-not-allowed" })
      expect(Payload.classify(press({ channel: { id: "D0OWNER" } }), owner)).toMatchObject({
        reason: "user-not-allowed"
      })
      expect(Payload.classify(dm({ channel: "C1" }), owner)).toMatchObject({ reason: "channel-not-allowed" })
    })

    it("still refuses echoes first, so the app's own DM reply is named as one", () => {
      expect(Payload.classify(dm({ bot_id: "B1", user: "UBOT" }), owner)).toMatchObject({ reason: "bot-author" })
      expect(Payload.classify(dm({ user: "UBOT" }), owner)).toMatchObject({ reason: "self-author" })
    })

    it("restricts a listed channel to the listed people", () => {
      const both: Payload.Policy = { ...owner, allowedChannelIds: ["C1"] }
      expect(Payload.classify(callback(message({ user: "UOWNER" })), both)).toMatchObject({ _tag: "Admitted" })
      expect(Payload.classify(callback(message({ user: "U1" })), both)).toMatchObject({ reason: "user-not-allowed" })
    })

    it("admits no direct message without people", () => {
      expect(verdict(dm({ channel: "D9" }))).toMatchObject({ reason: "channel-not-allowed" })
    })
  })
})

describe("idempotencyKey, correlations, names", () => {
  it("names the delivery identity of an event and a press, and nothing else", () => {
    expect(Payload.idempotencyKey(callback(message()))).toBe("slack:T1:Ev1")
    expect(Payload.idempotencyKey(press())).toBe("slack:T1:action:trigger-1")
    expect(Payload.idempotencyKey({ type: "url_verification" })).toBeUndefined()
  })

  it("orders thread, channel, then null", () => {
    expect(Payload.correlations(callback(message({ thread_ts: "1699999999.000001" })))).toEqual([
      "channel:C1:thread:1699999999.000001",
      "channel:C1",
      null
    ])
    expect(Payload.correlations(callback(message()))).toEqual(["channel:C1", null])
    expect(Payload.correlations({})).toEqual([null])
    const edited = message({
      subtype: "message_changed",
      message: { ts: "1700000000.000100", thread_ts: "1699999999.000001", user: "U1" }
    })
    expect(Payload.correlations(callback(edited))[0]).toBe("channel:C1:thread:1699999999.000001")
    expect(Payload.correlations(press({ container: { channel_id: "C1", thread_ts: "1699999999.000001" } }))[0])
      .toBe(Payload.threadCorrelationId("C1", "1699999999.000001"))
    expect(Payload.channelCorrelationId("C1")).toBe("channel:C1")
  })

  it("is empty for a payload it does not name", () => {
    expect(Payload.names({ type: "app_rate_limited" })).toEqual([])
    expect(Payload.names(press())).toEqual(["integration:slack:block_actions"])
  })
})

describe("redact", () => {
  it("removes the verification token and the response URL capabilities, and nothing else", () => {
    expect(Payload.redact({ token: "t", response_url: "u", response_urls: ["u"], type: "block_actions" }))
      .toEqual({ type: "block_actions" })
  })
})

describe("toExternalEvent", () => {
  it("produces a valid, redacted event keyed by the delivery", () => {
    const event = Payload.toExternalEvent(callback(message({ thread_ts: "1699999999.000001" })), {
      policy,
      source: "slack-main",
      receivedAtMs: 42
    })
    expect(event).toMatchObject({
      source: "slack-main",
      eventName: "integration:slack:message",
      correlationId: "channel:C1:thread:1699999999.000001",
      dedupeKey: "slack:T1:Ev1",
      receivedAtMs: 42
    })
    expect(JSON.stringify(event.payload)).not.toContain("legacy-verification-token")
    expect(Schema.is(ExternalEvent.ExternalEvent)(event)).toBe(true)
  })

  it("defaults the source and the clock", () => {
    const before = Date.now()
    const event = Payload.toExternalEvent(press(), { policy })
    expect(event.source).toBe("slack")
    expect(event.receivedAtMs).toBeGreaterThanOrEqual(before)
    expect(JSON.stringify(event.payload)).not.toContain("hooks.example.test")
  })

  it("throws a classified refusal", () => {
    try {
      Payload.toExternalEvent(callback(message({ bot_id: "B1" })), { policy })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(Payload.SlackRefused)
      expect((error as Payload.SlackRefused).refusal).toBe("bot-author")
      expect((error as Payload.SlackRefused).reason).toBe("permission-denied")
    }
  })
})
