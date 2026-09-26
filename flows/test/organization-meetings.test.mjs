/**
 * The weekly one-on-ones and extra time on the organization host, end to end
 * with scripted seats.
 *
 * With the Slack app (the integrations' Slack fixture: the Web API over HTTP
 * and Socket Mode over a real WebSocket) and no calendar: the plan is one
 * back-to-back block with each role's prepare, open, and follow-up triggers
 * in the series' zone and the calendar step `not connected`; a role prepares
 * its agenda into its private note; at the slot the agenda is posted in the
 * owner's direct messages under the role's name; the owner's reply in that
 * thread is answered by the role and starts no delivery; the follow-up turns
 * the thread into a task on the role's open list; a slot with no notes is
 * recorded as not held; and a role's request for extra time is booked by the
 * assistant, once per key. With a calendar connected (a fake Google Calendar
 * API) the series becomes one weekly event per role, a repeat plan duplicates
 * nothing, and a booking avoids the calendar's busy time.
 *
 * Run: node --test flows/test/organization-meetings.test.mjs
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, describe, it } from "node:test"
import { ok, refuse, startSlackFixture } from "../../packages/smithers/agent/integrations/test/SlackFixture.ts"
import { cleanup, host, organization, pause, repository, settled } from "../organization/testing/harness.mjs"

const DM = "D0OWNER1"
let fixture
let calendar
after(async () => {
  await cleanup()
  await fixture?.close()
  await new Promise((resolve) => calendar === undefined ? resolve() : calendar.close(resolve))
})

/** The example organization with the owner's meetings inputs set: Fridays from 10:00 in Los Angeles. */
const meetingsRoot = () =>
  organization((org) => {
    const page = join(org, "Meetings.md")
    writeFileSync(page, readFileSync(page, "utf8")
      .replace("timezone: null", "timezone: America/Los_Angeles")
      .replace("start: null", "start: \"10:00\"")
      .replace("firstDate: null", "firstDate: \"2026-10-02\""))
  })

const receiptOf = (root, key, name) =>
  JSON.parse(readFileSync(join(root, "Org/Runs", key.replaceAll(/[^A-Za-z0-9._-]/g, "-"), `${name}.json`), "utf8"))

const start = async (handle, flow, input, key) => {
  const started = await handle.ops.start(`organization/${flow}`, input, key)
  return settled(handle, started.runId)
}

describe("weekly one-on-ones on the organization host", () => {
  it("plans, prepares, opens in Slack, answers, follows up, and books extra time", { timeout: 300_000 }, async () => {
    let posted = 0
    fixture = await startSlackFixture((request, response) => {
      switch (request.method) {
        case "apps.connections.open":
          return ok(response, { url: fixture.socketUrl() })
        case "conversations.open":
          return ok(response, { channel: { id: DM } })
        case "chat.postMessage":
          return ok(response, { channel: request.params.channel, ts: `1800000100.${String(++posted).padStart(6, "0")}` })
        case "chat.getPermalink":
          return ok(response, { permalink: "https://example.slack.com/archives/D0OWNER1/p1" })
        case "conversations.replies":
          return ok(response, {
            messages: [
              { ts: request.params.ts, text: "agenda", bot_id: "B1" },
              { ts: "1800000200.000001", user: "UOWNER", text: "Ship the pricing page Friday." },
              { ts: "1800000200.000002", bot_id: "B1", text: "Noted." }
            ]
          })
        default:
          return refuse(response, "unknown_method")
      }
    })
    const root = meetingsRoot()
    const handle = await host(root, repository(), {
      SMITHERS_SLACK_BOT_TOKEN: "xoxb-fixture",
      SMITHERS_SLACK_APP_TOKEN: "xapp-fixture",
      SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
      SMITHERS_SLACK_TEAM_IDS: "T1",
      SMITHERS_SLACK_USER_IDS: "UOWNER",
      SMITHERS_ORGANIZATION_SLACK_FIXTURE: "1"
    })
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })

    // The plan: four back-to-back slots, no calendar, three triggers per role in the series' zone.
    assert.equal((await start(handle, "meetings-plan", {}, "plan-1")).status, "completed", handle.output())
    const plan = receiptOf(root, "meetings", "plan").report
    assert.equal(plan.status, "planned")
    assert.equal(plan.summary, "4 slots 10:00–12:00 America/Los_Angeles; 12 triggers")
    assert.equal(plan.calendar, "not connected: no calendar is connected")
    const page = readFileSync(join(root, "Org/Runs/meetings/plan.md"), "utf8")
    assert.match(page, /\| lead \| 10:30–11:00 \|/)
    const database = new DatabaseSync(join(handle.stateDir, "triggers.db"), { readOnly: true })
    const triggers = Object.fromEntries(
      database.prepare("SELECT trigger_id, flow_id, cron, timezone FROM flows_triggers").all().map((row) => [row.trigger_id, row])
    )
    database.close()
    assert.equal(triggers["organization-meetings:lead:prepare"].cron, "30 10 * * 4")
    assert.equal(triggers["organization-meetings:lead:open"].cron, "30 10 * * 5")
    assert.equal(triggers["organization-meetings:lead:follow-up"].cron, "5 11 * * 5")
    assert.equal(triggers["organization-meetings:lead:open"].timezone, "America/Los_Angeles")
    assert.equal(triggers["organization-meetings:lead:open"].flow_id, "organization/meetings-open")
    assert.equal(triggers["organization-meetings:plan"].flow_id, "organization/meetings-plan")

    // The lead prepares its agenda into its private note before the slot.
    const note = join(root, "Org/Runs/meetings/lead/2026-10-02.md")
    assert.equal((await start(handle, "meetings-prepare", { principal: "lead", at: Date.parse("2026-10-01T12:00:00Z") }, "prep-lead")).status, "completed", handle.output())
    assert.match(readFileSync(note, "utf8"), /## Agenda\n\n- lead: progress\n- Decision needed: none/)
    assert.equal(receiptOf(root, "meetings-lead-2026-10-02", "meeting-prepare").report.status, "prepared")

    // At the slot the agenda is posted in the owner's direct messages under the lead's name.
    assert.equal((await start(handle, "meetings-open", { principal: "lead", at: Date.parse("2026-10-02T17:30:00Z") }, "open-lead")).status, "completed", handle.output())
    const opened = fixture.calls.find((call) => call.method === "chat.postMessage" && call.params.username === "Lead")
    assert.ok(opened, JSON.stringify(fixture.calls.map((call) => call.method)))
    assert.equal(opened.params.channel, DM)
    assert.match(opened.params.text, /^1:1 · 2026-10-02 10:30 America\/Los_Angeles\n- lead: progress/)
    assert.equal(receiptOf(root, "meetings-lead-2026-10-02", "meeting-open").report.slack, "posted")
    const thread = "1800000100.000001"

    // The owner answers in the thread: the lead replies there, and no delivery starts.
    peer.send({
      envelope_id: "e-reply",
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev-reply",
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
        event: { type: "message", channel: DM, channel_type: "im", user: "UOWNER", text: "Ship the pricing page Friday.", ts: "1800000200.000001", thread_ts: thread }
      }
    })
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-reply" })
    const deadline = Date.now() + 60_000
    let reply
    while (reply === undefined && Date.now() < deadline) {
      reply = fixture.calls.find((call) => call.method === "chat.postMessage" && call.params.thread_ts === thread)
      await pause(200)
    }
    assert.ok(reply, handle.output())
    assert.equal(reply.params.text, "Noted: Ship the pricing page Friday.")
    assert.equal(reply.params.username, "Lead")
    assert.equal((await handle.ops.runs()).filter((view) => view.flowId === "organization/intake").length, 0)

    // After the slot the thread becomes a task on the lead's open list.
    assert.equal((await start(handle, "meetings-follow-up", { principal: "lead", at: Date.parse("2026-10-02T18:10:00Z") }, "follow-lead")).status, "completed", handle.output())
    assert.match(readFileSync(note, "utf8"), /## Tasks\n\n- \[ \] Ship the pricing page Friday\. \(lead\)/)
    assert.match(readFileSync(join(root, "Org/Runs/meetings/lead/tasks.md"), "utf8"), /- \[ \] Ship the pricing page Friday\. \(lead\) · 2026-10-02/)
    assert.ok(fixture.calls.some((call) => call.method === "conversations.replies" && call.params.ts === thread))

    // A slot nobody opened or wrote notes for is recorded as not held.
    assert.equal((await start(handle, "meetings-follow-up", { principal: "builder", at: Date.parse("2026-10-02T18:40:00Z") }, "follow-builder")).status, "completed")
    assert.match(readFileSync(join(root, "Org/Runs/meetings/builder/2026-10-02.md"), "utf8"), /Not held/)

    // The lead asks for extra time: the assistant books the first free slot, once per key.
    const request = { key: "book-1", requestedBy: "lead", purpose: "Pricing decision", minutes: 30, notBefore: Date.parse("2026-10-05T00:00:00Z") }
    assert.equal((await start(handle, "meetings-book", request, "book-1")).status, "completed", handle.output())
    const booked = receiptOf(root, "book-1", "book").report
    assert.equal(booked.summary, "2026-10-05 09:00 America/Los_Angeles, 30 minutes, booked by assistant")
    assert.equal(booked.calendar, "not connected")
    assert.equal((await start(handle, "meetings-book", { ...request, key: "book-2" }, "book-2")).status, "completed")
    assert.match(receiptOf(root, "book-2", "book").report.summary, /^2026-10-05 09:30 /)
    const bookings = readFileSync(join(root, "Org/Runs/meetings/bookings.md"), "utf8")
    assert.equal(bookings.split("\n").filter((line) => line.includes("Pricing decision")).length, 2)
    await handle.stop()
  })

  it("writes the series to a connected calendar once and books around its busy time", { timeout: 300_000 }, async () => {
    const events = new Map()
    const inserts = []
    calendar = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        const url = new URL(request.url, "http://calendar")
        const send = (status, value) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(value))
        }
        const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname)
        if (request.method === "POST" && match !== null && match[2] === undefined) {
          const event = JSON.parse(body)
          inserts.push(event)
          if (events.has(event.id)) return send(409, { error: { code: 409, message: "duplicate", errors: [{ reason: "duplicate" }] } })
          const stored = { ...event, status: "confirmed", htmlLink: `https://calendar.example/${event.id}` }
          events.set(event.id, stored)
          return send(200, stored)
        }
        if (request.method === "GET" && match !== null && match[2] !== undefined) {
          return events.has(match[2]) ? send(200, events.get(match[2])) : send(404, { error: { code: 404, message: "not found" } })
        }
        if (request.method === "POST" && url.pathname === "/freeBusy") {
          return send(200, {
            calendars: { primary: { busy: [{ start: "2026-10-05T16:00:00Z", end: "2026-10-05T17:00:00Z" }] } }
          })
        }
        return send(404, { error: { code: 404, message: "unknown" } })
      })
    })
    await new Promise((resolve) => calendar.listen(0, "127.0.0.1", resolve))
    const root = meetingsRoot()
    const handle = await host(root, repository(), {
      SMITHERS_ORG_CALENDAR_ID: "primary",
      SMITHERS_GOOGLE_ACCESS_TOKEN: "ya29.fixture",
      SMITHERS_GOOGLE_CALENDAR_API_BASE_URL: `http://127.0.0.1:${calendar.address().port}`
    })
    await handle.start()

    assert.equal((await start(handle, "meetings-plan", {}, "plan-a")).status, "completed", handle.output())
    assert.equal(receiptOf(root, "meetings", "plan").report.calendar, "connected")
    assert.equal(events.size, 4)
    const lead = [...events.values()].find((event) => event.summary === "1:1 · lead")
    assert.deepEqual(lead.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=FR"])
    assert.deepEqual(lead.start, { dateTime: "2026-10-02T17:30:00.000Z", timeZone: "America/Los_Angeles" })
    assert.equal(lead.visibility, "private")

    // Planning again duplicates nothing: the same keyed events are found, not added.
    assert.equal((await start(handle, "meetings-plan", {}, "plan-b")).status, "completed")
    assert.equal(events.size, 4)
    assert.equal(inserts.length, 8)

    // The booking avoids the calendar's busy hour and lands on the calendar too.
    const request = { key: "book-cal", requestedBy: "lead", purpose: "Launch review", minutes: 30, notBefore: Date.parse("2026-10-05T00:00:00Z") }
    assert.equal((await start(handle, "meetings-book", request, "book-cal")).status, "completed", handle.output())
    const booked = receiptOf(root, "book-cal", "book").report
    assert.equal(booked.summary, "2026-10-05 10:00 America/Los_Angeles, 30 minutes, booked by assistant")
    assert.equal(booked.calendar, "connected")
    assert.equal(events.size, 5)
    assert.equal(existsSync(join(root, "Org/Runs/meetings/bookings.md")), true)
    await handle.stop()
  })
})
