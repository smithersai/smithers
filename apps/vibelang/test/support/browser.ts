// Stays .ts: it drives happy-dom through DOM globals, which VibeLang rejects as host code (EK4402) and no Effect
// service provides (upstream-bugs/vibelang-dom-test-globals).
/** Native input events drive the same handlers as the browser; the tests never call update directly. */
export function send(text: string): void {
  const input = document.activeElement as HTMLTextAreaElement
  input.value = text
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
}
export function clickAsk(): void {
  document.querySelector<HTMLButtonElement>(".vl-ask")!.click()
}
export function clickMinimize(): void {
  document.querySelector<HTMLButtonElement>(".vl-minimize")!.click()
}
/** Each rendered message's label, then a post's text or whether a reply is done, in order. */
export function transcript(): Array<[string, string]> {
  return Array.from(document.querySelectorAll<HTMLElement>(".sui-chat-message[data-role='user'], .sui-chat-message[data-role='assistant']"))
    .map(message => [
      message.querySelector(".sui-chat-message-label")?.textContent ?? "",
      message.dataset.role === "user" ? message.querySelector(".sui-chat-bubble")?.textContent ?? "" : `done=${message.dataset.done}`,
    ])
}
export function reconnect(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  buttons.find(button => button.textContent === "Reconnect")!.click()
}
export function container(): HTMLDivElement {
  const node = document.createElement("div")
  node.id = `recovery-${crypto.randomUUID()}`
  document.body.append(node)
  return node
}
export function hasAsk(): boolean { return document.querySelector(".vl-ask") !== null }
export function activeId(): string | undefined { return document.activeElement?.id }
export function focusComposer(): void { document.querySelector<HTMLTextAreaElement>("[data-docked] textarea")!.focus() }
export function remove(node: HTMLElement): void { node.remove() }
/** Browser host primitives shared by the startup fault service and runtime tests. */
export function healthResponse(agent: "mock" | "live"): Response {
  return Response.json({ ok: true, agent })
}
export function commandK(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }))
}

/** A new element under `parent` or the body. */
export function addElement<E extends HTMLElement>(tag: string, id: string, parent?: HTMLElement): E {
  const node = document.createElement(tag) as E
  node.id = id
  ;(parent ?? document.body).append(node)
  return node
}
export function activeIs(node: Element): boolean { return document.activeElement === node }
export function location(): string { return `${window.location.pathname}${window.location.hash}` }
/** A real keydown at the document; true when a listener claimed it. */
export function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event.defaultPrevented
}
/** A real click on a link inside an element of `className`; true when a listener claimed it. */
export function clickLink(className: string, href: string, init: MouseEventInit = {}): boolean {
  const host = document.createElement("div")
  host.className = className
  const link = document.createElement("a")
  link.setAttribute("href", href)
  host.append(link)
  document.body.append(host)
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init })
  link.dispatchEvent(event)
  host.remove()
  return event.defaultPrevented
}
/** The browser's back or forward landing on `path`. */
export function popTo(path: string): void {
  window.history.replaceState(null, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
export function dispatchWindow(type: string): void { window.dispatchEvent(new Event(type)) }
export function fullLocation(): string { return `${window.location.pathname}${window.location.search}${window.location.hash}` }
export function setLocation(path: string): void { window.history.replaceState(null, "", path) }

/** A touch event at `clientY`, carrying the one finger the transcript follows. */
export function dispatchTouch(type: string, clientY: number): void {
  document.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { touches: type === "touchend" || type === "touchcancel" ? [] : [{ identifier: 1, clientY }] }))
}

/** Happy DOM lays nothing out, so a page has no height; this gives it one and returns the undo. */
export function tallPage(height: number): () => void {
  const root = document.documentElement
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: height })
  return () => { Reflect.deleteProperty(root, "scrollHeight") }
}

export function chatShown(): boolean { return document.querySelector(".vl-app[data-surface='chat']") !== null }

export function fire(target: EventTarget, type: string): void { target.dispatchEvent(new Event(type)) }

/** The page's window with both storages refused, as a private window or a blocked site refuses them. */
export function refusingStorage(): Window {
  return new Proxy(window, {
    get(target, property) {
      if (property === "localStorage" || property === "sessionStorage") throw new DOMException("denied", "SecurityError")
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** The tour journals the page keeps in its local storage (`vibelang:walkthrough:<conversation>`). */
export function journalKeys(): ReadonlyArray<string> {
  return Object.keys(window.localStorage).filter((key) => key.startsWith("vibelang:walkthrough:"))
}

/** A stored journal's events, or undefined when the key holds nothing or text that isn't a JSON array. */
export function storedJournal(key: string): ReadonlyArray<{ readonly seq: number }> | undefined {
  const text = window.localStorage.getItem(key)
  if (text === null) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Removes the stored journals, the finished-tour mark and this tab's tour keys. */
export function forgetTours(): void {
  journalKeys().forEach((key) => window.localStorage.removeItem(key))
  window.localStorage.removeItem("vibelang:toured")
  for (const key of ["vibelang:tour-session", "vibelang:tour-active"]) window.sessionStorage.removeItem(key)
}

/** The real window whose local storage refuses only the tour journal's keys; `refused` lists each refused call. */
export function refusingJournal(): { readonly window: Window; readonly refused: Array<"read" | "write"> } {
  const refused: Array<"read" | "write"> = []
  const journal = (key: string) => key.startsWith("vibelang:walkthrough:")
  const storage = new Proxy(window.localStorage, {
    get(target, property) {
      if (property === "getItem") return (key: string) => { if (journal(key)) { refused.push("read"); throw new DOMException("denied", "SecurityError") } return target.getItem(key) }
      if (property === "setItem") return (key: string, value: string) => { if (journal(key)) { refused.push("write"); throw new DOMException("denied", "SecurityError") } target.setItem(key, value) }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const page = new Proxy(window, {
    get(target, property) {
      if (property === "localStorage") return storage
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { window: page, refused }
}

/** The text of the first element matching `css` on the page, or undefined when none matches. */
export function textOf(css: string): string | undefined {
  return document.querySelector(css)?.textContent ?? undefined
}

/** Focuses the first element matching `css`; throws while none is on the page, so a wait can retry it. */
export function focusOn(css: string): void {
  document.querySelector<HTMLElement>(css)!.focus()
}

/** The real window with a recording speech host; `utterances: false` is a browser without SpeechSynthesisUtterance,
 * `host: false` one without speechSynthesis. */
export function speakingWindow(utterances: boolean, host = true): { readonly window: Window; readonly calls: Array<string> } {
  const calls: Array<string> = []
  const speech = {
    cancel: () => { calls.push("cancel") },
    pause: () => { calls.push("pause") },
    resume: () => { calls.push("resume") },
    speak: (utterance: { readonly text: string }) => { calls.push(`speak ${utterance.text}`) },
  }
  class Utterance { constructor(readonly text: string) {} }
  const page = new Proxy(window, {
    get(target, property) {
      if (property === "speechSynthesis") return host ? speech : undefined
      if (property === "SpeechSynthesisUtterance") return utterances ? Utterance : undefined
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { window: page, calls }
}

/** An element of `className` in the page whose layout box is `box` (Happy DOM lays nothing out). */
export function framed(tag: string, className: string, box: { readonly top: number; readonly left: number; readonly right: number; readonly bottom: number }): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.getBoundingClientRect = () => DOMRect.fromRect({ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top })
  document.body.append(node)
  return node
}

/** The href attribute of the first element matching `css`, or undefined. */
export function hrefOf(css: string): string | undefined {
  return document.querySelector(css)?.getAttribute("href") ?? undefined
}
