import "./fixtures/dom"
import { Effect, Metric } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { Branch } from "../src/features/branch/branch"
import { BranchProvider } from "../src/features/branch/components/BranchContext"
import { Chat } from "../src/features/chat/chat"
import { Composer } from "../src/features/chat/components/Composer"
import { Commands } from "../src/features/commands/commands"
import { CommandsProvider } from "../src/features/commands/components/CommandsContext"
import { submits } from "../src/features/commands/metrics"
import { openTestApp } from "../src/test/chatApi"

test("Enter in the real composer runs the exact name despite a displaced highlight", async () => {
  const app = openTestApp({ answers: true, sessionLifecycle: false })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    const chat = await app.runPromise(Effect.service(Chat))
    const branch = await app.runPromise(Effect.service(Branch))
    const commands = await app.runPromise(Effect.service(Commands))
    const auth = await app.runPromise(Effect.service(AuthStore))
    await app.runPromise(auth.session.update(SESSION, row => {
      Object.assign(row, { status: "signed_in", login: "composer-member", role: "member" })
    }))
    await act(async () => {
      root.render(createElement(ChatProvider, { value: chat },
        createElement(BranchProvider, { value: branch },
          createElement(CommandsProvider, { value: commands }, createElement(Composer)))))
      chat.actions.openComposer("button")
      commands.actions.type("/bug")
      commands.actions.highlight(1)
    })
    const input = host.querySelector("textarea")!
    expect(input.value).toBe("/bug")
    expect(host.querySelector('[aria-selected="true"] .sui-completion-label')?.textContent).toBe("/bugs")
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    const count = (command: string) => app.runSync(Metric.value(Metric.withAttributes(submits, { outcome: "run", command }))).count
    expect(count("bug")).toBe(1)
    expect(count("bugs")).toBe(0)
    expect(host.querySelector("textarea")!.value).toBe("")
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await app.dispose()
  }
}, 60_000)
