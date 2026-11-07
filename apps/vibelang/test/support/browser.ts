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
