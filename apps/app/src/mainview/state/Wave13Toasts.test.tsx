/*
 * Wave 13 B-6 — a correction never renders as an error state.
 *
 * The launch-morning sweep watched a correction ("No — I meant the other
 * repo") and found one `[role="alert"]` on screen: not an error at all, but
 * the "Your repositories are ready to choose" toast, rendered by the shared
 * Alert component whose hardcoded role="alert" is an assertive ERROR
 * landmark. A calm notification is a status, not an alert — only a failed
 * toast may claim the alert role. Pinned here at the render boundary.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ToastStack } from "../ToastStack"
import type { Toast } from "./AppState"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const toast = (id: string, status: Toast["status"]): Toast => ({
  id,
  key: id,
  title: "Your repositories are ready to choose",
  detail: "",
  status,
  createdAt: 1,
  updatedAt: 1
})

const renderToasts = (toasts: ReadonlyArray<Toast>): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ToastStack toasts={toasts} onDismiss={() => {}} />))
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return host
}

describe("wave 13 B-6 — a notification is a status, never an alert", () => {
  test("running and ok toasts render role=status — no alert surface", () => {
    const host = renderToasts([toast("t1", "running"), toast("t2", "ok")])
    expect(host.querySelectorAll("[role=\"alert\"]").length).toBe(0)
    expect(host.querySelectorAll(".toast[role=\"status\"]").length).toBe(2)
  })

  test("only a FAILED toast is an alert", () => {
    const host = renderToasts([toast("t1", "ok"), toast("t2", "failed")])
    expect(host.querySelectorAll(".toast[role=\"status\"]").length).toBe(1)
    expect(host.querySelectorAll(".toast[role=\"alert\"]").length).toBe(1)
  })
})
