// @vitest-environment happy-dom
import type { TurnFrame } from "../src/api.ts"
import { act, createElement } from "react"
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import BuildPage from "../app/build/page.tsx"
import { actions } from "../src/shell/store.ts"

// A stream the test feeds one frame at a time, so each frame lands in its own
// `act` and React cannot batch the ten deltas into one render.
const turn = vi.hoisted(() => ({
  push: (_frame: unknown): void => undefined,
  end: (): void => undefined
}))
vi.mock("../src/shell/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell/client.ts")>()
  return {
    ...actual,
    listSessions: async () => [{ id: "ses_one", title: "One", status: "ready" as const, stage: "Plan", at: 0 }],
    streamTurn: async function* () {
      const queue: Array<TurnFrame | undefined> = []
      let wake: (() => void) | undefined
      turn.push = (frame) => { queue.push(frame as TurnFrame); wake?.() }
      turn.end = () => { queue.push(undefined); wake?.() }
      while (true) {
        if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve })
        const frame = queue.shift()
        if (frame === undefined) return
        yield frame
      }
    }
  }
})
const counts = vi.hoisted(() => ({ relativeTime: 0, composer: 0 }))
vi.mock("@smthrs/ui", async () => {
  const { createElement } = await import("react")
  const container = ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children)
  const hidden = () => null
  return {
    Card: container, CardContent: container, CardDescription: container, CardHeader: container, CardTitle: container,
    ChatTranscript: container, ChatMessage: container, CollapsiblePanel: container,
    Badge: container, Select: container, Button: container,
    ChatComposer: () => { counts.composer += 1; return null },
    EmptyState: hidden, FileTree: hidden, StatusPill: hidden,
    SelectContent: hidden, SelectItem: hidden, SelectTrigger: hidden, SelectValue: hidden,
    Dialog: hidden, DialogContent: hidden, DialogDescription: hidden, DialogHeader: hidden, DialogTitle: hidden,
    formatRelativeTime: () => { counts.relativeTime += 1; return "now" }
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  actions.newSession()
  vi.unstubAllGlobals()
})

describe("BuildPage render scope", () => {
  test("streamed deltas re-render neither the Recent column nor the composer", async () => {
    await act(() => actions.refreshSessions())
    await act(() => root.render(createElement(BuildPage)))

    let submitted: Promise<void> = Promise.resolve()
    await act(async () => {
      submitted = actions.submit("build an arb bot")
      turn.push({ type: "delta", text: "a" })
    })
    const recent = counts.relativeTime
    const composer = counts.composer
    for (let index = 0; index < 10; index += 1) {
      await act(async () => turn.push({ type: "delta", text: "b" }))
    }
    expect(container.textContent).toContain("abbbbbbbbbb")
    expect(counts.relativeTime - recent).toBe(0)
    expect(counts.composer - composer).toBe(0)
    await act(async () => { turn.end(); await submitted })
  })
})
