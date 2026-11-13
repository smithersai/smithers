---
title: "API reference"
description: "Every export of @smthrs/terminal-frame: TerminalFrame, its props and handle, the generated frame runtime, and the messages between the frame and the page."
sidebar:
  order: 1
---

Everything below is exported from the package root, `@smthrs/terminal-frame`.
The package has no other entry point.

## Terminal frame

xterm.js and its fit addon run in an opaque-origin frame; the page bundles
them only as the frame runtime's text.

```ts
function TerminalFrame(props: TerminalFrameProps): JSX.Element

type TerminalFrameProps = Omit<ComponentProps<"div">, "children" | "title" | "onInput" | "onResize" | "ref"> & {
  title: string
  theme: TerminalFrameTheme
  readOnly?: boolean
  screenReaderMode?: boolean
  stream: TerminalFrameStream
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onKey?: (key: TerminalFrameKey) => void
  onLink?: (url: string) => void
  runtime?: string
  ref?: Ref<TerminalFrameHandle>
}
type TerminalFrameStream = (write: TerminalFrameWriter) => () => void
type TerminalFrameWriter = { readonly output: (bytes: Uint8Array | string) => void }
type TerminalFrameHandle = { readonly focus: () => void }
type TerminalFrameKey = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
type TerminalFrameTheme = "light" | "dark"

const terminalFrameRuntime: string
```

`TerminalFrame` shows `<iframe sandbox="allow-scripts" srcdoc
referrerPolicy="no-referrer">` with the document `ViewCsp.frameDocument`
writes: the frame runtime is its only script, pinned by hash, and
`connect-src 'none'` leaves the frame no network. `style-src 'unsafe-inline'`
stays, because xterm.js injects `<style>` elements and writes 24-bit colors
as `style` attributes. The frame mounts only while it is within 200 px of the
screen, with a new nonce and document each time.

The frame asks with `terminal/initialize` and its nonce. The page answers
only its own frame's `contentWindow`, only with this mount's nonce and only
once, and transfers a `MessagePort`; everything after uses the port.

| Message | Direction | Params |
| --- | --- | --- |
| `terminal/initialize` | frame to page, window | `{ nonce }`; the answer's `result` is `{ theme, colors, readOnly, screenReaderMode }` |
| `terminal/output` | page to frame | `{ bytes }`, a transferred `Uint8Array` |
| `terminal/options` | page to frame | `{ theme, colors, readOnly, screenReaderMode }`, after any changes |
| `terminal/focus` | page to frame | `{}` |
| `terminal/input` | frame to page | `{ data }`, at most 1 MiB |
| `terminal/resize` | frame to page | `{ cols, rows }`, integers from 1 to 65,535, first and after each fit that changes them |
| `terminal/key` | frame to page | a `TerminalFrameKey`, for ⌘K and Ctrl+K only |
| `terminal/link` | frame to page | `{ url }`, an `http:` or `https:` URL of at most 2048 characters |

`stream` runs each time the frame connects; its teardown runs when the frame
unmounts or leaves the screen. `output` transfers a `Uint8Array` that spans
its whole buffer, so the caller must not reuse it; anything else is copied,
and a string is sent as UTF-8. `colors` is the terminal palette for `theme`
from the document's `data-palette`.

`readOnly` sets xterm's `disableStdin` and removes the frame's input listener,
and the page drops any `terminal/input` while it is set. `Tab` and `Shift+Tab`
move focus into and out of a read-only terminal. In a writable terminal,
`Ctrl+Shift+M` toggles “Tab moves focus”; while enabled, `Tab` and
`Shift+Tab` move focus instead of reaching the shell. Toggle it again to
restore shell tab completion. ⌘K and Ctrl+K reach `onKey` and never the
shell; `Esc` stays in the shell. Set `screenReaderMode` to `true` to expose
xterm's accessible output rows and live region; it defaults to `false` and
can change while connected.

Hovering an OSC 8 link or a URL in the text shows its full destination as
text in a strip at the bottom of the frame. If an OSC 8 link's visible text
is a web URL whose host differs from the destination's, clicking it focuses
that strip without opening anything. Click the destination in the strip
(or press `Enter` while it is focused) to confirm; the second click of a
double-click confirms nothing. Ordinary links still open on the first click.

A link is posted only for a person's click, and the page acts on it only
while it has the person's activation: `onLink`, or by default
`window.open(url, "_blank", "noopener,noreferrer")`. The frame loads no
clipboard (OSC 52) addon and follows no link itself. `ref.focus()` focuses the
terminal.
