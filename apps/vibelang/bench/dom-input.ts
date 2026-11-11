// Stays .ts: host DOM input for benchmarks that drive the real app in happy-dom (bench/web-dom.bench.vibe).

/** A primary-button click, or a Ctrl-click with `modifier`, that bubbles from `element` like a pointer's. */
export function click(element: Element, modifier = false): void {
  element.dispatchEvent(new MouseEvent("click", { button: 0, ctrlKey: modifier, bubbles: true, cancelable: true }))
}

/** One test channel: `send` delivers a message to the app's `step` subscription; no product subscription is replaced. */
export interface Steps<M> {
  readonly target: EventTarget
  send(message: M): void
  read(event: Event): M
}

export function steps<M>(): Steps<M> {
  // A DOM node, as the app's own event subscriptions use: Foldkit listens on elements and documents.
  const target: EventTarget = document.createElement("div")
  return {
    target,
    send: (message) => { target.dispatchEvent(new CustomEvent("step", { detail: message })) },
    read: (event) => (event as CustomEvent<M>).detail,
  }
}

/** The `href` of every element matching `selector`. */
export function hrefs(page: ParentNode, selector: string): Array<string> {
  return Array.from(page.querySelectorAll(selector)).map((element) => element.getAttribute("href") ?? "")
}

/** A key pressed while `element` has focus: it takes focus first, then a bubbling, cancelable keydown. */
export function press(element: HTMLElement, key: string): void {
  element.focus()
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

/** The id of the focused element, "" for none. */
export function focusedId(page: Document): string {
  return page.activeElement?.id ?? ""
}

/** A keydown on `target` (the document, for page-wide keys), with Shift when `shift`. */
export function keyOn(target: EventTarget, key: string, shift = false): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }))
}

/** The index of the focused element among those matching `selector`, -1 for none. */
export function focusedIndex(page: Document, selector: string): number {
  return Array.from(page.querySelectorAll(selector)).findIndex((element) => element === page.activeElement)
}
