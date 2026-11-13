import { Browser } from "happy-dom"

// Own every docs popup, so the test waits for their real navigation and closes them together.
export const browser = new Browser()
export const page = browser.newPage()
export const dom = page.mainFrame.window
Object.assign(globalThis, {
  window: dom,
  self: dom,
  customElements: dom.customElements,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  scrollTo: dom.scrollTo.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLIFrameElement: dom.HTMLIFrameElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Node: dom.Node,
  Element: dom.Element,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
})
