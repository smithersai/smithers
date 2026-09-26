import { expect } from "@playwright/test"
import { AGENT_SESSION_WIRE, sseFrame } from "../../../src/mainview/state/seams/fixtures/AgentSessionWire"
import { showcase } from "../showcase"

const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/agent/sessions`
const ID = "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a"
const OLDER = "7a1e9b52-4c0d-4e8f-b1a2-93c5d6e7f801"
const TASK = "Fix the retry loop in the stack toast"

const text = (id: number, role: string, sequence: number, value: string) =>
  AGENT_SESSION_WIRE.message({ id, role, sequence, parts: [{ part_index: 0, type: "text", content: { value } }] })

export default showcase({
  id: "agent-sessions",
  order: 107,
  title: "Agent sessions",
  summary: "A Claude session on Smithers Cloud streams into its card; follow up, stop, list.",
  flows: ["agent.session.new", "card.maximize", "agent.session.say", "agent.session.stop", "agent.session.list", "agent.session.view"],
  run: async ({ page, app, backend }) => {
    let status = "active"
    const messages = [text(41, "user", 1, TASK)]
    const replies = [
      text(42, "assistant", 2, "Found it: `retryLane` re-queues before the toast settles. Patching `ToastStack.tsx`."),
      text(44, "assistant", 4, "Added a test for a lane retried twice; `bun test src/mainview` passes.")
    ]
    let streamed = 0
    const session = (id: string, extra: Record<string, unknown> = {}) =>
      AGENT_SESSION_WIRE.session({ id, title: id === ID ? TASK : "Tighten stack lane seats", status: id === ID ? status : "completed", message_count: id === ID ? messages.length : 6, ...extra })
    await backend.cloud()
    await backend.route(url => url.pathname.startsWith(BASE), async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname.slice(BASE.length)
      const method = request.method()
      if (path === "" && method === "POST") return route.fulfill({ status: 201, json: session(ID) })
      if (path === "" && method === "GET") return route.fulfill({ json: [session(ID), session(OLDER, { created_at: "2026-09-24T16:10:00Z" })] })
      const [, id = "", rest = ""] = path.split("/")
      if (rest === "messages" && method === "POST") {
        const body = request.postDataJSON() as { text: string }
        // The first message is the task already on the session; a follow-up is a new row.
        const posted = messages.length === 1 ? messages[0]! : text(43, "user", 3, body.text)
        if (posted !== messages[0]) messages.push(posted)
        return route.fulfill({ status: 201, json: { ...posted, session_id: id } })
      }
      if (rest === "messages") return route.fulfill({ json: id === ID ? messages : [text(1, "user", 1, "Tighten stack lane seats"), text(2, "assistant", 2, "Seats now show the model under each lane.")].map(row => ({ ...row, session_id: id })) })
      if (rest === "stream") {
        // Each connection delivers what arrived since the last one, then ends; the client reconnects.
        const fresh = replies.slice(streamed, Math.min(replies.length, messages.length > 1 ? 2 : 1))
        streamed += fresh.length
        for (const message of fresh) messages.push(message)
        const frames = fresh.map(message => sseFrame(AGENT_SESSION_WIRE.messageEvent(message, ID), { id: message.id })).join("") +
          (status === "active" ? "" : sseFrame(AGENT_SESSION_WIRE.statusEvent(status, ID)))
        await new Promise(resolve => setTimeout(resolve, 600))
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: frames || ":ka\n\n" })
      }
      if (method === "DELETE") { status = "cancelled"; return route.fulfill({ status: 204, body: "" }) }
      return route.fulfill({ json: session(id) })
    })

    await app.open("/")
    await app.click(page.getByRole("button", { name: "Dismiss", exact: true }))
    await app.slash(`/agent.session.new ${REPO} claude ${TASK}`)
    const card = page.locator('[data-kind="agent"][data-testid*="0c3d0c6e"], [data-kind="agent"]').last()
    await expect(card.getByTestId("agent-session-header")).toContainText("claude · active")
    await app.closeComposer()
    await app.show(card)
    await app.maximize(card)
    await expect(card.getByTestId("agent-session-transcript")).toContainText("retryLane", { timeout: 15_000 })
    await app.beat(1000)

    await app.slash(`/agent.session.say ${ID} Also cover a lane retried twice`)
    await app.closeComposer()
    if (await card.getAttribute("data-maximized") !== "true") await app.maximize(card)
    await expect(card.getByTestId("agent-session-transcript")).toContainText("bun test src/mainview", { timeout: 15_000 })
    await app.beat(1000)

    await app.click(card.getByTestId(`agent-session-stop-${ID}`))
    await expect(card.getByTestId("agent-session-header")).toContainText("cancelled", { timeout: 10_000 })
    await app.beat(900)
    if (await card.getAttribute("data-maximized") === "true") await app.click(card.getByRole("button", { name: "Restore" }))

    await app.slash(`/agent.session.list ${REPO}`)
    await expect(page.getByTestId("transcript")).toContainText("Tighten stack lane seats")
    await app.closeComposer()
    await app.beat(900)
    await app.slash(`/agent.session.view ${OLDER} ${REPO}`)
    const older = page.locator('[data-kind="agent"]').filter({ hasText: OLDER }).last()
    await expect(older).toContainText("completed")
    await app.closeComposer()
    await app.show(older)
    await app.maximize(older)
    await expect(older.getByTestId("agent-session-transcript")).toContainText("Seats now show the model")
  }
})
