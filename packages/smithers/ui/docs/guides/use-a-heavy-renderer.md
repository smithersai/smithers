---
title: "Use a heavy renderer"
description: "Pick the adapter subpath for a terminal, a chart, a graph, or a code editor, wire its props, and keep its dependency out of your application's initial chunk."
---

Four renderers in this package carry a heavy third-party dependency, and each
one ships behind its own subpath so importing the base library never loads it.
This guide is how to reach one on purpose.

A diff, a highlighted file, a Markdown editor or a whole repository is
`@smthrs/repo-view`'s, and a sandboxed shell is `@smthrs/terminal-frame`'s; each
package has its own guide.

Before you do, check whether the light surface already covers the job: see the
table in [The adapters boundary](../concepts/adapters.md). Rendering markdown, a
plain diff, or fenced code needs no adapter at all.

## Load the module lazily

An adapter import is a chunk boundary. Put the adapter in a module of its own,
import that module lazily from the surface that needs it, and the dependency
stays out of your application's first paint. One module imports
`@smthrs/ui/adapters/chart`, and the card that renders it reaches it through
`React.lazy`.

```tsx
import { lazy, Suspense } from "react"
import { Skeleton } from "@smthrs/ui"

const ChartSurface = lazy(() => import("./ChartSurface"))

export function RunsCard({ passed, failed }: { readonly passed: number; readonly failed: number }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <ChartSurface passed={passed} failed={failed} />
    </Suspense>
  )
}
```

## Attach a terminal

`Terminal` owns the emulator, the fit addon, theming, and resize. The data
source is entirely on props, so the component knows nothing about your
transport. Three seams cover a live session:

```tsx
import { Terminal } from "@smthrs/ui/adapters/terminal"

interface TerminalSession {
  readonly input: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly attach: (sink: { readonly onOutput: (bytes: string) => void }) => () => void
}

export function SessionTerminal({ session }: { readonly session: TerminalSession }) {
  return (
    <Terminal
      onData={(data) => session.input(data)}
      onResize={({ cols, rows }) => session.resize(cols, rows)}
      stream={(write) => session.attach({ onOutput: write })}
    />
  )
}
```

`stream` is called once, right after the emulator opens, with a `write` function
that pushes bytes in. Return a teardown from it to unsubscribe on unmount.
`lines` writes a snapshot instead, for a recorded session with no live source.
`onReady` hands back the raw xterm.js instance when you need to load an addon or
read the buffer.

The xterm base stylesheet is vendored as a string and injected through the same
style seam the rest of the library uses. Never add
`import "@xterm/xterm/css/xterm.css"` yourself: a bundler configured to drop CSS
artifacts discards it silently.

`Terminal` runs xterm.js in your page, so give it only output you trust. A live
shell's output belongs in `TerminalFrame` from `@smthrs/terminal-frame`, which
runs xterm.js in a sandboxed frame with no network.

## Draw a chart

`ChartContainer` is the shadcn chart contract over Recharts. Series colors come
from a fixed, contrast-validated palette in slot order:

```tsx
import { CHART_SERIES, chartConfig, chartSeriesColor } from "@smthrs/ui/adapters/chart"

const config = chartConfig([{ key: "passed", label: "Passed" }, { key: "failed", label: "Failed" }])
const firstSeriesLight: string = chartSeriesColor(0, "light")
const slots: number = CHART_SERIES.length // 8
```

Never reorder, cycle, or generate hues past the eight slots. An index past the
palette clamps to the last slot rather than wrapping, which is deliberate: fold
the tail into an "Other" series or facet the chart instead.

## Draw a vault graph

`KnowledgeGraph` renders over a `d3-force` simulation. The graph math is not
behind the subpath: `computeGraphModel`, `nodeRadius`, `folderTint`, and
`neighbourSet` are on the base barrel, so a host can compute and inspect a graph
without loading the renderer.

```tsx
import { computeGraphModel } from "@smthrs/ui"
import { KnowledgeGraph } from "@smthrs/ui/adapters/knowledge-graph"

const model = computeGraphModel(notes, links)
const nodeCount: number = model.nodes.length
```

## Show a code editor

`CodeEditorView` provides read-only CodeMirror highlighting unless the
host supplies an approved live `EditorBinding`.

```tsx
import { CodeEditorView } from "@smthrs/ui/adapters/code-editor"

<CodeEditorView
  path="src/example.tsx"
  text={'export const Greeting = () => <span>Hello</span>'}
  language="tsx"
  diagnostics={[]}
  onAction={(tag, args) => dispatch(tag, args)}
  onView={({ line }) => rememberLine(line)}
/>
```

The host supplies `dispatch` and `rememberLine`. An empty
`gestures` map is sufficient for a read-only surface with no actions.
Coordinates use 1-based lines and zero-based UTF-16 columns. A live binding
supplies text and CodeMirror extensions, such as Yjs's `yCollab` from
`y-codemirror.next`. Keep its `identity` stable across visual updates;
replace it only when switching the synchronized document. The adapter discovers
no transport or permissions. See the [editor API](../api.md#code-editor-smthrsuiadapterscode-editor)
for callbacks and replacement behavior.

## Confirm what landed in your bundle

An adapter belongs to whichever chunk imports it, so the check is your bundler's
production output rather than anything in this package. Build for production and
find the chunk that holds the adapter's dependency. It should be a lazily loaded
chunk. If it is the entry chunk, a module on your initial route imports the
adapter eagerly: follow the import back and move it behind the lazy boundary.

Importing `@smthrs/ui` itself never pulls a heavy dependency in, which
[The adapters boundary](../concepts/adapters.md) explains and the package's test
suite enforces.

## Related

- [The adapters boundary](../concepts/adapters.md): why the boundary exists and
  what each subpath costs.
- [API reference](../api.md): every export of every adapter.
- `@smthrs/repo-view`'s guide "Use the repository views" and
  `@smthrs/terminal-frame`'s guide "Frame a shell".
