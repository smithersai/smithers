---
title: "API reference"
description: "Every export of @smthrs/views: the ViewCode, PresentationRealm, Presentation, ViewCsp, Bridge, Interactions, Home, Docs and WebPage namespaces, their models, constructors and errors."
---

The package root exports nine namespaces and nothing else:

```ts
import {
  Bridge,
  Docs,
  Home,
  Interactions,
  Presentation,
  PresentationRealm,
  ViewCode,
  ViewCsp,
  WebPage
} from "@smthrs/views"
```

## `ViewCode`

### `ViewCode.check`

```ts
const check: (source: string, options: CheckOptions) => Effect.Effect<CheckedModule, ViewCodeError>
```

Checks and compiles a view module. `options.components` is the component
names the presentation bundle carries, usually `realm.components`. It parses
the module with `@babel/parser`, reads its `interactions`, refuses what a view
may not do, and compiles it with sucrase (`typescript`, `jsx`, `imports`, the
automatic JSX runtime) to the CommonJS body the realm evaluates.

It refuses:

- more than `maxSourceBytes` (64 KiB) of UTF-8, or a lone UTF-16 surrogate;
- imports other than `react` (values `Fragment`, `createElement`,
  `Children`, `cloneElement`, `isValidElement`; any type), `@smthrs/ui` (named
  components from `options.components`) and `smithers:view` (`event`,
  `ViewProps`, `ViewEvent`); `React.<name>` outside the same values;
- dynamic `import()`, `import.meta`, `import x = require()`, `export =`,
  `export ... from`, namespaces and `declare` blocks, `debugger`;
- exports other than `default`, `interactions`, `reduce` and types;
- an async or generator `default` or `reduce` function, including local
  aliases; nested async helpers remain valid;
- the names `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `caches`,
  `document`, `window`, `globalThis`, `self`, `location`, `top`, `parent`,
  `opener`, `postMessage`, `setTimeout`, `setInterval`,
  `requestAnimationFrame`, `queueMicrotask`, `Date`, `performance`, `eval`,
  `Function`, `Proxy`, `Reflect`, `require`, `module`, `exports`, `process`,
  `WebAssembly` and the others in `src/internal/vocabulary.ts`, and
  `Math.random`;
- the properties `constructor`, `__proto__`, `prototype`,
  `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `srcdoc`,
  `contentWindow`, `cookie` and the other accessors in the vocabulary,
  including properties in JSX member tags; forbidden names are refused as
  JSX tag roots too;
- the elements `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`,
  `a`, `style`, `template`, `foreignObject`, `use`, `image`, `animate`, media
  elements and the others in the vocabulary, in JSX or as a literal
  `createElement` type;
- every `on*` attribute, `href`, `src` (except a `data:image` URL on `<img>`),
  `srcSet`, `action`, `formAction`, `formTarget`, `target`, `download`,
  `ping`, `poster`, `background`, `data`, `srcdoc`, `sandbox`, `allow`,
  `httpEquiv`, `xmlns` and namespaced attributes such as `xlink:href`;
- `javascript:` and `vbscript:` anywhere in a string, template or JSX text,
  and `<!--` or `-->` anywhere in the source;
- an `interactions` export that is not an object literal of declared
  interactions, a `state` interaction without `reduce`, and a literal
  `data-event` that is malformed or names an undeclared event.

### `ViewCode.CheckedModule`

```ts
class CheckedModule {
  readonly source: string // the TSX as written
  readonly compiled: string // the CommonJS body the realm evaluates
  readonly digest: string // SHA-256 of source, lowercase hex
  readonly interactions: Interactions.Declared
  readonly reduces: boolean // whether it exports reduce
}
```

### `ViewCode.ViewCodeError`

```ts
class ViewCodeError {
  readonly _tag: "@smthrs/views/ViewCodeError"
  readonly reason: "too_large" | "malformed_text" | "syntax" | "refused"
  readonly detail: Redacted.Redacted<string> // one line per problem, "line:column: message"
  readonly problems: Redacted.Redacted<ReadonlyArray<{ message: string; line?: number; column?: number }>>
  readonly message: string // the reason only
}
```

`detail` and `problems` are written for the renderer that wrote the module,
at most `maxProblems` (20) problems in source order. They quote the module's
identifiers and text, which a model can fill with conversation content, so
both print as `<redacted>`; read them with `Redacted.value` for a correction
prompt, never for a log, a span or a metric. `message` is fixed text for the
reason, such as `The view's module does something a view may not`, so a
caller's own span or log line around a check carries no module content.

### Constants

`maxSourceBytes` (65536), `maxProblems` (20), `modules`, `reactValues`,
`viewValues`.

## `PresentationRealm`

### `PresentationRealm.make`

```ts
const make: (options: Options) => Effect.Effect<Realm, RealmError, QuickJSVariant.Variant | Scope.Scope>

interface Options {
  readonly bundle: string // the presentation bundle's source
  readonly limits?: Partial<Limits> | undefined
}
```

Loads a realm over the bundle for the life of the scope. It compiles the
QuickJS build the host names (`QuickJSVariant` from `@smthrs/harness`), at most
once per build, removes `Date`, `Math.random`, `Proxy`, `WeakRef` and
`FinalizationRegistry` and `InternalError`, evaluates the bundle, and fails with `load_failed` when
the bundle throws or installs no renderer. That runtime serves the first call;
every later render or interaction loads the bundle into a fresh runtime, and
each runtime closes after its call, so nothing one view changes reaches
another. Once its scope closes, every call fails with `load_failed`.

### `PresentationRealm.layer`

```ts
const layer: (options: Options) => Layer.Layer<PresentationRealm, RealmError, QuickJSVariant.Variant>
```

### `PresentationRealm.Realm`

```ts
interface Realm {
  readonly render: (
    input: { module: CheckedModule; props: unknown; state: unknown }
  ) => Effect.Effect<string, RealmError>
  readonly interact: (
    input: { module: CheckedModule; props: unknown; state: unknown; event: Interactions.Event }
  ) => Effect.Effect<{ state: unknown; html: string }, RealmError>
  readonly components: ReadonlyArray<string>
}
```

- `render` evaluates the module afresh and renders its default export with
  `{ props, state }` through `renderToStaticMarkup`.
- `interact` runs `reduce(state, event)` and renders the state it returns.
  A thenable result fails with `render_failed` instead of replacing the state.
- `components` is what the bundle resolves `@smthrs/ui` to, for
  `ViewCode.check`.

Props and state must be JSON. Each call is traced as
`PresentationRealm.render` or `PresentationRealm.interact`. A failed call's
span ends through `SpanFailure` from `@smthrs/flow`: its status reads
`redacted`, and only the attributes `realm.reason` and `realm.limit` say why.

### `PresentationRealm.Limits` and `defaultLimits`

| Limit         | Default | Bounds                                                             |
| ------------- | ------- | ------------------------------------------------------------------ |
| `memoryBytes` | 64 MiB  | the realm's heap                                                   |
| `stackBytes`  | 128 KiB | the interpreter's stack; keep it under a third of the host's stack |
| `loadMs`      | 10 000  | loading the bundle                                                 |
| `renderMs`    | 1 000   | one render or interaction                                          |
| `steps`       | 2 000   | interrupt polls per render, about ten thousand operations each     |
| `propsBytes`  | 256 KiB | a render's props, as UTF-8 JSON                                    |

State is bounded by `Bridge.maxStateBytes` (16 KiB) on the way in and out, and
HTML by `Bridge.maxHtmlBytes` (512 KiB).

### `PresentationRealm.RealmError`

```ts
class RealmError {
  readonly _tag: "@smthrs/views/RealmError"
  readonly reason: "load_failed" | "invalid_input" | "render_failed" | "limit_exceeded"
  readonly limit?: "time" | "steps" | "memory" | "stack" | "html" | "state" | "props"
  readonly detail: Redacted.Redacted<string> // for the renderer; read with Redacted.value
  readonly message: string // the reason and the limit only
}
```

After a time, step, memory or stack limit the realm loads again on its next
call. A host stack overflow instead abandons the runtime without disposal and
quarantines its shared WASM module. Calls and new realms over that module fail
closed; supply a fresh variant to recover.

`detail` says what went wrong for the renderer that wrote the module, such as
`RangeError: no board`. It can quote the module or what the module threw,
which can be its props, state or event, so it prints as `<redacted>`; read it
with `Redacted.value` for a correction prompt, never for a log, a span or a
metric. `message` is fixed text for the reason and the limit, such as
`The view's module failed` or `The view crossed its steps limit`, so a
caller's own span or log line around a render carries no view content.

### `PresentationRealm.limitHits`

`Metric.Counter<number>` named `realm.limit_hit`, with the attribute `limit`.

## `Presentation`

The realm half of a presentation bundle. It runs inside QuickJS, so it imports
nothing but this package's vocabulary.

### `Presentation.install`

```ts
const install: (options: InstallOptions) => Installed

interface InstallOptions {
  readonly react: { Fragment; createElement; Children; cloneElement; isValidElement }
  readonly jsxRuntime: { Fragment; jsx; jsxs }
  readonly renderToStaticMarkup: (element: any) => string
  readonly components: Readonly<Record<string, unknown>>
}
```

Publishes the renderer at `globalThis.__smithersPresentation` (`globalName`)
and deeply freezes everything a view reaches by name: the realm's global and
its prototypes, and `require` with every module behind it, React's `Children`,
each component and its statics, the element constructors and `event`
included. A bundle calls it once, as its last statement. A view's `require` resolves `react`,
`react/jsx-runtime`, `@smthrs/ui` (the components, frozen) and
`smithers:view`; anything else throws. The `react` and `react/jsx-runtime`
element constructors refuse refused elements and attributes early.

Before it publishes, it sets `globalThis.__smithersHostGuard`
(`hostGuardName`) to `guardHost` and renders an element built by hand as
`<script>`; if the renderer emits it, `install` throws, so a bundle whose
renderer skips the guard never loads.

### `Presentation.guardRenderer`

```ts
const guardRenderer: (source: string) => string
```

Patches the source of React's static renderer
(`react-dom/cjs/react-dom-server-legacy.browser.production.js`) so every
element it emits passes `guardHost` first, whether a constructor, a component
or the view's own hand built it, and whatever changed it afterwards. A bundle
builder applies it where it loads that file, for example in an esbuild
`onLoad` hook. It throws when the source has no single
`pushStartInstance(target, type, props, ...)`.

### `Presentation.guardHost`

```ts
const guardHost: (type: string, props: unknown) => Readonly<Record<string, unknown>>
```

Reads an element's own enumerable props once, drops event handlers (React
never emits one, and a component such as Radix's `Label` sets its own),
refuses what `ViewCode` refuses, and returns the frozen copy the renderer
emits.

### `Presentation.make`

The same renderer without publishing it on the global, for tests. It shallow-freezes the React, JSX-runtime, component and `smithers:view` facades; deep hardening happens only during `install`. It renders with the `renderToStaticMarkup` it is given, guarded or not.

### `Presentation.Installed`

```ts
interface Installed {
  readonly render: (factory: ModuleFactory, props: string, state: string) => string
  readonly reduce: (factory: ModuleFactory, state: string, event: string) => string
  readonly components: ReadonlyArray<string>
}
```

## `ViewCsp`

| Export                                             | What it is                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox`                                          | `"allow-scripts"`, the frame's whole `sandbox` attribute                                                                                                                                                                                              |
| `nonceAttribute`                                   | `"data-smithers-nonce"`, where the frame document carries the mount's nonce                                                                                                                                                                           |
| `hash(script)`                                     | `'sha256-<base64>'` over the script's UTF-8                                                                                                                                                                                                           |
| `policy(runtimeHash)`                              | the frame's CSP: `default-src 'none'`, `script-src` the hash, `script-src-attr 'none'`, `style-src 'unsafe-inline'`, `img-src data:`, `font-src data:`, and `'none'` for connect, media, object, frame, child, worker, manifest, base and form-action |
| `frameDocument({ runtime, nonce, theme, styles })` | the frame's `srcdoc`: the policy, the styles and the runtime, with no view content. CRLF and lone CR become LF before escaping `</script` and hashing; NUL is refused. A `</style` inside styles is escaped                                           |

## `Bridge`

The four messages, JSON-RPC 2.0, named after MCP Apps where they overlap:

| Schema               | Method                                  | Direction                                                                   |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `Initialize`         | `ui/initialize`                         | frame to page, by window message, with `{ nonce }`                          |
| `InitializeResult`   | (the answer)                            | page to frame, with `{ html, theme, size }` and a transferred `MessagePort` |
| `HostContextChanged` | `ui/notifications/host-context-changed` | page to frame, `{ html?, theme? }`                                          |
| `SizeChanged`        | `ui/notifications/size-changed`         | frame to page, `{ height }`                                                 |
| `Interaction`        | `smithers/interaction`                  | frame to page, `{ event, arg?, values? }`                                   |

### `Bridge.receive`

```ts
const receive: (input: {
  message: unknown
  declared: Interactions.Declared
  window: RateWindow
  now: number
}) => { verdict: Verdict; window: RateWindow }

type Verdict =
  | { _tag: "Resize"; height: number }
  | { _tag: "State"; event: Interactions.Event }
  | { _tag: "Message"; event: Interactions.Event; label: string; values: Values }
  | { _tag: "Refused"; reason: "wrong_source" | "malformed" | "too_large" | "undeclared" | "rate_limited" }
```

What the page does with one message from the frame's port. It decodes the
message, refuses values over `maxValuesBytes` (16 KiB), an event the view did
not declare (own properties only), and more than `maxInteractionsPerSecond`
(10) in any second. Start `window` empty and keep the one it returns.

### `Bridge.acceptInitialize`, `initializeResult`, `hostContextChanged`

`acceptInitialize(message, nonce)` decodes `ui/initialize` and checks the
nonce; the caller checks that the message came from its own frame.
`initializeResult(initialize, context)` and `hostContextChanged(params)` write
the page's messages.

### Sizes and bounds

`Size` (`"inline" | "full"`), `Theme` (`"light" | "dark"`), `inlineHeight`
(80 to 480), `inlineFrameHeight(reported)`, `maxStateBytes`, `maxHtmlBytes`,
`maxValues` (64), `maxReportedHeight`.

## `Interactions`

| Export                   | What it is                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Name`                   | a lowercase letter, then up to 31 letters, digits, `_` or `-`                                                |
| `Interaction`            | `{ kind: "state" }` or `{ kind: "message", label }`                                                          |
| `Declared`               | a module's `interactions`: at most `maxDeclared` (32), every key a `Name`                                    |
| `Event`                  | `{ name, arg? }`, what `reduce` receives                                                                     |
| `parse(attribute)`       | reads `"name"` or `"name:arg"`; everything after the first `:` is the argument, at most `maxArgLength` (256) |
| `format(event)`          | the inverse of `parse`                                                                                       |
| `lookup(declared, name)` | the declared interaction, or `None`; inherited names never match                                             |

## `Home`

A repository's own home: the sections and blocks `.smithers/home.json` declares, and who sees each section. See
[Read a repository's home](read-a-home.md). `Home.Url` accepts safe absolute
HTTP(S) URLs and origin-relative paths starting with one `/`; `Home.DocsUrl`
requires absolute HTTPS URLs without credentials.

| Export                                                                                                                       | What it is                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                                                                                                                       | `".smithers/home.json"`                                                                                                                                                                                             |
| `read(text)`                                                                                                                 | `{ _tag: "Declared", sections, contributors, docs?, skipped }` or `{ _tag: "Invalid", reason }`; never throws                                                                                                       |
| `Read`, `Invalid`, `Section`                                                                                                 | the answer; why a file is not a home: `json`, `shape`, `sections`, `section`, `blocks` or `block`; a section `{ title?, audience, blocks }`                                                                         |
| `Audience`, `audiences`                                                                                                      | `everyone`, `contributor`, `maintainer`, from the widest                                                                                                                                                            |
| `Contributors`                                                                                                               | who counts as a contributor: `role` or `anyone`                                                                                                                                                                     |
| `sees(viewer, section)`, `visible(sections, viewer)`, `widen(viewer, contributors)`                                          | whether an audience may see a section's; the sections it may see, in order; `everyone` as a contributor on a home open to anyone                                                                                    |
| `SectionHeading`                                                                                                             | a section's `{ title?, audience? }` as declared                                                                                                                                                                     |
| `Block`, `kinds`, `liveKinds`                                                                                                | the union of the sixteen block schemas, and its type; every kind; the live ones, `flows`, `stack`, `issues`, `runs`                                                                                                 |
| `TextBlock`, `LinksBlock`, `FlowsBlock`, `PromptBlock`                                                                       | `{ type, title?, text }`; `{ type, title?, links: [{ label, url }] }`; `{ type, title? }`; `{ type, flow?, title?, placeholder? }`                                                                                  |
| `MarkdownBlock`, `StackBlock`, `AppBlock`, `ViewBlock`                                                                       | `{ type, path, title? }`; `{ type, title? }`; `{ type, flow, title, picture }`; `{ type, flow }`                                                                                                                    |
| `HeroBlock`, `CodeBlock`, `CardsBlock`, `StatsBlock`, `ReleasesBlock`                                                        | `{ type, title, tagline?, text?, install?, actions?, announcement? }`; `{ type, code, file?, language?, title? }`; `{ type, cards, title?, more? }`; `{ type, stats, title? }`; `{ type, releases, title?, more? }` |
| `IssuesBlock`, `RunsBlock`, `ActionBlock`                                                                                    | `{ type, title? }`; `{ type, title? }`; `{ type, flow, title, key? }`                                                                                                                                               |
| `Card`, `Stat`, `Release`, `Link`                                                                                            | `{ title, text?, label?, url? }`; `{ value, label }`; `{ name, url, date, summary? }`; `{ label, url }`                                                                                                             |
| `Title`, `Prose`, `Line`, `Command`, `Code`, `Language`, `IsoDate`, `Key`, `Url`, `RepositoryPath`, `FlowName`, `AppPicture` | the field schemas the blocks share                                                                                                                                                                                  |
| `DocsUrl`                                                                                                                    | the `docs` field: an `https` URL with no user or password, at most 2,048 characters                                                                                                                                 |
| `maximumSections`, `maximumBlocks`, `maximumEntries`, `maximumStats`, `maximumActions`                                       | 8, 32, 12, 6, 3                                                                                                                                                                                                     |
| `maximumTitleLength`, `maximumLineLength`, `maximumTextLength`, `maximumCodeLength`, `maximumUrlLength`, `htmlPattern`       | 120, 280, 4,096, 4,096, 2,048, and the pattern of a tag, a closing tag, a comment or a processing instruction                                                                                                       |

## `Docs`

A docs site's `llms.txt` index: read it, find and search its pages, and fetch it or a page from a server, guarded. See
[Read a docs index](read-a-docs-index.md).

| Export                                                                           | What it is                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse(text, indexUrl)`                                                          | `{ title, summary?, pages }`, the pages on the index's origin, in order; never throws                                                                                                   |
| `find(index, path)`, `search(index, query, limit?)`                              | the page at a path; the pages matching the query's words, best first, at most `limit` (5)                                                                                               |
| `fetchText(url, options?)`                                                       | `Effect<Fetched, never, HttpClient>`: `{ _tag: "Text", text, type, url }` or `{ _tag: "Refused", reason, status? }`                                                                     |
| `Index`, `Page`                                                                  | the schemas and types of an index and a page `{ title, url, path, description?, section? }`                                                                                             |
| `Fetched`, `FetchRefusal`, `FetchOptions`                                        | the answer; `invalid_url`, `private_host`, `redirects`, `unreachable`, `timeout`, `status`, `content`, `too_large`; `{ privateHosts?, maxRedirects?, timeout?, maxBytes?, userAgent? }` |
| `maximumPages`, `maximumTitleLength`, `maximumDescriptionLength`, `defaultLimit` | 1,000, 200, 300, 5                                                                                                                                                                      |

## `WebPage`

Whether an outside page shows in a frame, asked from a server, and the card
shown in its place. See [Check a web page before framing it](check-a-web-page.md).

| Export                                         | What it is                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check(url, options)`                          | `Effect<Checked, never, HttpClient>`: requests the page as a frame would, guarded on every hop; never fails                                                                                  |
| `Options`                                      | `{ ancestors, privateHosts?, maxRedirects? (5), timeout? (8 s), headTimeout? (3 s), maxBytes? (256 KiB), userAgent? }`                                                                       |
| `Checked`                                      | schema and type: `{ framing, reason?, status?, title?, description?, icon? }`                                                                                                                |
| `Preview`                                      | schema and type: `{ title?, description?, icon? }`                                                                                                                                           |
| `FRAMINGS`, `Framing`                          | `allowed`, `refused`, `unknown`                                                                                                                                                              |
| `REASONS`, `Reason`                            | `x_frame_options`, `frame_ancestors`, `insecure`, `content`, `status`, `invalid_url`, `private_host`, `redirects`, `timeout`, `unreachable`                                                  |
| `framing(headers, { page, ancestors })`        | `{ framing: "allowed" }` or `{ framing: "refused", reason }` from headers; malformed page or ancestor URLs, or an empty ancestor list, yield `{ framing: "unknown", reason: "invalid_url" }` |
| `content(headers)`                             | whether a sandboxed frame shows the response: not an attachment, a PDF or an octet stream                                                                                                    |
| `preview(html, pageUrl)`                       | the `Preview` read from a page's head                                                                                                                                                        |
| `HeaderRecord`                                 | response headers by name, in any case                                                                                                                                                        |
| `MAX_TITLE`, `MAX_DESCRIPTION`, `MAX_ICON_URL` | 200, 300 and 2,048 UTF-16 code units                                                                                                                                                         |
