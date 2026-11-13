---
title: "Frame a shell"
description: "Show a live shell with TerminalFrame: wire the stream, input and size, make it read-only, and handle ⌘K and links."
---

A shell's output is untrusted: it can carry escape sequences and links. Show a
live shell with `TerminalFrame`, which runs xterm.js in a sandboxed frame with
no network while your page keeps the connection:

```tsx
import { TerminalFrame } from "@smthrs/terminal-frame"

interface TerminalSession {
  readonly input: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly attach: (sink: { readonly onOutput: (bytes: Uint8Array | string) => void }) => () => void
}

export function ShellTerminal({ session, watching, openCommandPalette }: {
  readonly session: TerminalSession
  readonly watching: boolean
  readonly openCommandPalette: () => void
}) {
  return (
    <TerminalFrame
      title="Terminal"
      theme="dark"
      readOnly={watching}
      style={{ height: 320 }}
      onInput={(data) => session.input(data)}
      onResize={(cols, rows) => session.resize(cols, rows)}
      onKey={() => openCommandPalette()}
      stream={(write) => session.attach({ onOutput: write.output })}
    />
  )
}
```

Give the frame a height; it fills its container. `stream` runs again each time
the frame scrolls back near the screen, so attach there and detach in its
teardown. In a browser, `TerminalSocket` from `@smthrs/platform-browser` is the
session: it reconnects, drops keystrokes typed while offline, and keeps only
the latest size.

`readOnly` shows someone else's shell: the frame takes no input and the page
drops any that arrives. `Tab` and `Shift+Tab` leave a read-only terminal.
In a writable terminal, `Ctrl+Shift+M` toggles whether those keys move focus
or reach the shell. Set `screenReaderMode={true}` when the person needs
accessible output rows and announcements.

⌘K and Ctrl+K reach `onKey` and never the shell. Hover a link to see its
full destination at the bottom of the frame. An OSC 8 link whose URL label
names a different host needs a second click on that destination to open.
A confirmed link reaches `onLink`, or opens in a new tab with no opener
by default.

## Related

- [API reference](../api.md): the props and the frame's protocol.
