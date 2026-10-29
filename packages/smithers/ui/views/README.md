# `@smthrs/views`

Generated views as safe arbitrary output. A renderer agent writes a TSX
module; this package checks it, renders it to HTML inside a bounded QuickJS
realm, writes the sandboxed frame the HTML shows in, and admits only the
events the module declares. No model-written code ever runs in the browser's
own JavaScript engine.

The realm's HTML is untrusted. Its renderer refuses a script, a handler, raw
HTML or a remote source in each element as it emits it, but only while the
bundle builds that renderer through `Presentation.guardRenderer`. Show the
HTML only through `GeneratedView`, whose sanitizer and CSP treat it as
hostile, or sanitize it the same way.

The package is framework-free. `@smthrs/ui` supplies the presentation bundle
(React, its static renderer and the components a view may import) and
`GeneratedView`, the React component that shows the frame. The design is
decision [0004](../../../../apps/mvp/docs/decisions/0004-agent-ui-codemode-and-rendering.md).

**Documentation:** [`docs/`](docs/README.md)

## Install

Install it with its peer dependency; it is published under the `next` tag
with the rest of Smithers' packages:

```sh
npm install @smthrs/views@next effect@4.0.5
```

It imports no Node built-in, so it runs in a browser, a Cloudflare Worker,
Node 22.19 or later and Bun. The realm compiles the QuickJS build the host names through
`QuickJSVariant` from `@smthrs/harness`.

## Quickstart

```ts
import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import { loadPresentationBundle } from "@smthrs/ui"
import { PresentationRealm, ViewCode } from "@smthrs/views"
import { Effect, Layer } from "effect"

const source = `import { Button, Card } from "@smthrs/ui"
export const interactions = { add: { kind: "state" } }
export const reduce = (state: number) => state + 1
export default function View({ state }: { state: number }) {
  return <Card><Button data-event="add">Clicked {state} times</Button></Card>
}`

const program = Effect.gen(function*() {
  const realm = yield* PresentationRealm.PresentationRealm
  const module = yield* ViewCode.check(source, { components: realm.components })
  const html = yield* realm.render({ module, props: {}, state: 0 })
  const next = yield* realm.interact({ module, props: {}, state: 0, event: { name: "add" } })
  return { html, next }
})

// The single-file build compiles from its own bytes in Node and a browser. A
// Worker names a build its toolchain compiled instead (see docs/render-a-view.md).
const realm = PresentationRealm.layer({ bundle: await loadPresentationBundle() }).pipe(
  Layer.provide(QuickJSVariant.layerVariant(singlefile))
)

const { html, next } = await Effect.runPromise(program.pipe(Effect.provide(realm)))
```

Show `html` with `<GeneratedView html interactions onInteraction />` from
`@smthrs/ui`. Each state event runs `realm.interact` again; each message event
becomes a question from the person.

## Tests

`pnpm test` runs the suite at 100% coverage of `src/`: the checker and its
fuzzing with retained counterexamples, the realm's bounds, the bridge, the
CSP, and the same renders in local workerd through Miniflare.
