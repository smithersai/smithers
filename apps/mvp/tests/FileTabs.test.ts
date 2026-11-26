import { dom } from "./fixtures/dom"
import { FileTabs, type FileTab } from "@smthrs/ui"
import { Effect } from "effect"
import { act, createElement, Fragment, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, afterEach, expect, test } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Branch } from "../src/features/branch/branch.vibe"
import { BranchProvider } from "../src/features/branch/components/BranchContext"
import { Chat } from "../src/features/chat/chat"
import { Composer } from "../src/features/chat/components/Composer"
import { Commands } from "../src/features/commands/commands.vibe"
import { CommandsProvider } from "../src/features/commands/components/CommandsContext"
import { openTestApp } from "../src/test/chatApi"

afterAll(() => dom.happyDOM.close())
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

const FILES: ReadonlyArray<FileTab> = [
  { key: "README.md", label: "README.md", href: "/readme", active: true },
  { key: "index.html", label: "index.html", href: "/index?L=2-4", active: false },
]

// Real composer/services and file-strip DOM. A branch navigation removes the
// composer while tracking, then mounts it when ready; its strip stays mounted.
const mount = async ({ open = true, readOnly = false } = {}) => {
  const runtime = openTestApp({ sessionLifecycle: false })
  disposals.push(() => runtime.dispose())
  const chat = await runtime.runPromise(Effect.service(Chat))
  const branch = await runtime.runPromise(Effect.service(Branch))
  const commands = await runtime.runPromise(Effect.service(Commands))
  if (open) chat.actions.openComposer("button")
  else chat.actions.closeComposer()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  disposals.push(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const closed: Array<string> = []
  const opened: Array<string> = []
  const render = (ready = true, files = FILES) => act(async () => root.render(
    createElement(StrictMode, null, createElement(ChatProvider, { value: chat },
      createElement(BranchProvider, { value: branch },
        createElement(CommandsProvider, { value: commands },
          createElement(Fragment, null,
            createElement(FileTabs, { tabs: files, onOpen: (tab) => { opened.push(tab.key) },
              onClose: (tab) => { closed.push(tab.key) } }),
            ready ? createElement(Composer, { docked: false, readOnly }) : null)))))))
  await render()
  return {
    chat, commands, closed, opened, container, render,
    tabs: () => [...container.querySelectorAll<HTMLElement>("[role=tab]")],
    input: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
  }
}

test.each([
  ["Delete", 0, 1],
  ["Backspace", 1, 0],
] as const)("%s keeps focus on the remaining file when the branch composer remounts", async (key, closing, remaining) => {
  const screen = await mount()
  const tabs = screen.tabs()
  tabs[closing]!.focus()
  await act(async () => {
    tabs[closing]!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
  expect(screen.closed).toEqual([FILES[closing]!.key])
  expect(document.activeElement).toBe(tabs[remaining])
  // Optimistic removal, persistence receipt, then navigation retracks the branch.
  const files = [{ ...FILES[remaining]!, active: true }]
  await screen.render(false, files)
  expect(screen.tabs().map((tab) => tab.textContent)).toEqual([FILES[remaining]!.label])
  expect(document.activeElement).toBe(tabs[remaining])
  await screen.render(true, files)
  expect(document.activeElement).toBe(tabs[remaining])
  expect(screen.tabs()[0]!.getAttribute("aria-selected")).toBe("true")
  expect(screen.tabs()[0]!.getAttribute("href")).toBe(FILES[remaining]!.href)
  // The keyboard remains in the strip and can still open the file.
  await act(async () => {
    screen.tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))
  })
  expect(screen.opened).toEqual([FILES[remaining]!.key])
  expect(document.activeElement).toBe(tabs[remaining])
})

test("opening before mount focuses the composer once; draft changes preserve file focus", async () => {
  const screen = await mount()
  expect(document.activeElement).toBe(screen.input())
  screen.tabs()[0]!.focus()
  await act(async () => screen.commands.actions.type("draft"))
  expect(screen.input().value).toBe("draft")
  expect(document.activeElement).toBe(screen.tabs()[0])
})

test("opening Chat by button or shortcut requests focus from a file tab", async () => {
  const screen = await mount({ open: false })
  expect(screen.input()).toBeNull()
  const button = screen.container.querySelector<HTMLButtonElement>("button[aria-keyshortcuts]")!
  button.focus()
  await act(async () => button.click())
  expect(document.activeElement).toBe(screen.input())
  await act(async () => screen.chat.actions.closeComposer())
  screen.tabs()[0]!.focus()
  await act(async () => screen.chat.actions.openComposer("shortcut"))
  expect(document.activeElement).toBe(screen.input())
})

test("a read-only composer never takes focus from a file", async () => {
  const screen = await mount({ readOnly: true })
  expect(screen.input().readOnly).toBe(true)
  expect(document.activeElement).toBe(document.body)
  screen.tabs()[0]!.focus()
  await screen.render(false)
  await screen.render(true)
  expect(document.activeElement).toBe(screen.tabs()[0])
})

// Opening requests focus once. A route remount has no new opening action, even
// when Suspense temporarily left focus on the body.
test("remounting an open composer with idle focus does not request focus again", async () => {
  const screen = await mount()
  expect(document.activeElement).toBe(screen.input())
  await screen.render(false)
  expect(document.activeElement).toBe(document.body)
  await screen.render(true)
  expect(document.activeElement).toBe(document.body)
})
