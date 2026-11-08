import { FIRST_PAINT_GLOBAL, SETTLED_ATTRIBUTE, startShell } from "./shell"

// The shell's inline script (src/firstPaint/shell.ts): vite.config.ts bundles this module into index.html's `<body>`,
// before `#root` and the app's module, so the first paint's read starts as the document parses. It hands the browser's
// objects to the shell and leaves the shell on `window` for the app (src/firstPaint/page.ts).
const shell = startShell({
  window,
  document,
  locks: navigator.locks,
  fetch: window.fetch.bind(window),
  now: () => Date.now(),
  // Read when used: a browser that blocks storage throws, which the shell reads as a mark.
  marks: { getItem: (key) => localStorage.getItem(key) },
  channel: (name) => new BroadcastChannel(name),
  observe: (callback) => {
    const observer = new MutationObserver(callback)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [SETTLED_ATTRIBUTE] })
    return observer
  },
  mark: (name, detail) => void performance.mark(name, { detail }),
})
if (shell !== undefined) (window as unknown as Record<string, unknown>)[FIRST_PAINT_GLOBAL] = shell
