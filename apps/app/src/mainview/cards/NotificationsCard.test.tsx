import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { NotificationsCardBody } from "./NotificationsCard"

/*
 * §28.2: an empty state names the next step. "Nothing new." told the user a
 * fact and gave them no move.
 */

GlobalRegistrator.register()

afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const card = (
  items: Extract<Card, { kind: "notifications" }>["payload"]["items"]
): Extract<Card, { kind: "notifications" }> => ({
  id: "notifications",
  kind: "notifications",
  title: "Notifications",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { unread: items.filter((item) => !item.read).length, items }
})

const render = (
  body: Extract<Card, { kind: "notifications" }>,
  onRunCommand: (name: string, args?: string) => void = () => {}
): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<NotificationsCardBody card={body} onRunCommand={onRunCommand} />)
  })
  return host
}

describe("the notifications empty state", () => {
  test("reads calm and invents no next step", () => {
    const host = render(card([]))
    expect(host.innerText ?? host.textContent ?? "").toContain("Nothing new.")
    expect(host.textContent).toContain("repositories you have loaded")
    expect(host.querySelector("[data-flow]")).toBeNull()
  })

  test("a populated inbox renders its rows and no empty state", () => {
    const host = render(
      card([{ id: "1", title: "canary fixture", repo: null, reason: null, createdAt: null, read: false }])
    )
    expect(host.textContent).toContain("canary fixture")
    expect(host.textContent).not.toContain("Nothing new.")
  })
})
