---
title: "Security model"
description: "How a generated view is kept from the page and from telemetry: the checker, the QuickJS realm, a fresh frozen runtime per render, content-free failures, the sanitizer, the frame's sandbox and CSP, and the bridge, with what each stops and which test holds it."
---

A view is arbitrary output from a model, so every layer assumes the one
before it failed.

| Layer         | Where                                                  | Stops                                                                                                                                                                                                                                                                                                   | Held by                                                                                                          |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Checker       | `ViewCode.check`                                       | Imports outside three modules, dynamic `import()`, `eval`, network, storage, page, timer, clock and randomness names, `constructor` and `__proto__`, refused elements and attributes, `javascript:` URLs, HTML comment tokens, undeclared `data-event` literals                                         | `test/ViewCode.test.ts`, `test/ViewCode.property.test.ts`                                                        |
| Realm         | `PresentationRealm`                                    | Any authority: the realm is a WebAssembly interpreter with no module loader, network, storage or host object; values cross as JSON strings. `Date`, `Math.random`, `Proxy`, `WeakRef`, `FinalizationRegistry` and `InternalError` are removed                                                           | `test/PresentationRealm.test.ts`                                                                                 |
| Bounds        | `PresentationRealm`                                    | Hangs and crashes: time, steps, memory, stack, HTML, state and props                                                                                                                                                                                                                                    | `test/PresentationRealm.test.ts`                                                                                 |
| Render guard  | `Presentation.guardRenderer`, `Presentation.guardHost` | A refused element or attribute the checker cannot see: a spread, a computed name, an element built by hand or changed after a constructor checked it. The renderer runs the guard on each element as it emits it, on a frozen copy of its props, and `install` refuses a bundle whose renderer does not | `test/Presentation.test.ts`, `test/PresentationRealm.test.ts`, `test/ViewCode.property.test.ts`                  |
| Fresh runtime | `PresentationRealm`                                    | One view reading another's props or changing what another renders, through anything it reaches: each render and interaction loads the bundle into a QuickJS runtime of its own, closed after the call                                                                                                   | `test/PresentationRealm.test.ts`                                                                                 |
| Frozen realm  | `Presentation.install`                                 | A view changing a shared object inside its runtime: the global and every prototype, and `require` with every module behind it, deeply: React's `Children`, each component and its statics, the element constructors, `event`. The change throws a `TypeError`                                           | `test/PresentationRealm.test.ts`                                                                                 |
| Telemetry     | `PresentationRealm`, `RealmError`, `ViewCodeError`     | A view's props, state, event or source leaving through a span, a log line or a metric when it fails: the realm's spans end through `SpanFailure`, each error's `message` names only its reason and limit, and what the module threw or what the checker quotes stays in the redacted `detail`           | `test/ContentFree.test.ts`, `test/PresentationRealm.test.ts`, `test/ViewCode.test.ts`                            |
| Sanitizer     | `@smthrs/ui` frame runtime                             | Anything in the HTML that runs, loads or navigates: an inert parse, then an allowlist copy                                                                                                                                                                                                              | `packages/smithers/ui/tests/generated-view-sanitize.test.ts`, Chromium fuzzing in `packages/smithers/ui/browser` |
| Frame         | `ViewCsp`, `GeneratedView`                             | The page's DOM, cookies and storage (opaque origin), popups, top navigation, form submission, modals; script other than the hashed runtime, inline handlers, every fetch                                                                                                                                | `test/ViewCsp.test.ts`, `packages/smithers/ui/browser`                                                           |
| Bridge        | `Bridge.receive`, `GeneratedView`                      | Messages from another window or with another nonce, undeclared events, oversized values, floods                                                                                                                                                                                                         | `test/Bridge.test.ts`, `packages/smithers/ui/tests/generated-view.test.tsx`, `packages/smithers/ui/browser`      |

## What the browser probes check

`packages/smithers/ui/browser/generated-view.browser.test.ts` loads a page
with a `GeneratedView` in Chromium and checks, for a hostile view:

- **Parent DOM:** a marker element in the page stays unchanged.
- **Storage:** the page's `localStorage` and cookie stay unchanged, and a
  script in the frame cannot read them.
- **Network:** no request leaves the page for any other origin; the frame's
  CSP stops `fetch`, images, beacons and workers before they are sent.
- **Navigation:** the frame stays at `about:srcdoc` after every element in it
  is clicked, and `top.location` and `window.open` are refused.
- **Inline handlers:** none survives the sanitizer, and one written by a
  script anyway never runs (`script-src-attr 'none'`).

The second probe swaps in a hostile frame runtime, as if a sanitizer bypass
had let script run, to show the CSP and the sandbox hold on their own.

## What the telemetry probe checks

`test/ContentFree.test.ts` checks a module whose identifier is a sentinel,
renders and plays real checked modules that throw a sentinel taken from their
props, state or event, and renders one that imports a module named by it. Each runs inside a host's ordinary span that logs the
failure, under Effect's OTLP exporters for traces, logs and metrics, writing
to a collector that keeps every request body. The sentinel must appear in
none of those bodies:

- **The realm's span** ends with the status `redacted` and the attributes
  `realm.reason` and `realm.limit`, never what the module threw.
- **The host's span and log line** carry the error's fixed `message`, such
  as `The view's module failed` or
  `The view's module does something a view may not`, and a printed `detail`
  or `problems` reads `<redacted>`.
- **The renderer** still reads the module's own words with
  `Redacted.value(error.detail)`, for a correction prompt.

A frame's network isolation would mean little if a view's data could leave
through the host's telemetry, so a failure's telemetry carries only reasons,
limits and counts (`obs.content-free`).

## Known limits

- **A frame can navigate itself if script runs in it.** CSP has no directive
  against self-navigation. The design answer is that no untrusted script runs
  in the frame: the sanitizer removes every link, form action, refresh and
  handler, and the CSP admits only the hashed runtime.
- **The stack bound is relative to the host's stack.** QuickJS must stop a
  recursion before the host's own stack does. The default, 128 KiB, costs
  about 384 KiB of host stack. A host stack overflow inside the realm leaves
  that runtime unusable; the realm abandons it and quarantines the shared WASM
  module. Further calls and realm construction over that module fail closed,
  bounding abandoned runtimes to one per module. A host must supply a fresh
  variant to recover.
- **A component's internals stay writable inside one runtime.** Calling a
  component returns elements whose types, such as Radix's `Slot` or a
  context, no freeze reaches: a closure hides them, and React writes some of
  them on every render. The fresh runtime per call is what keeps a change to
  them from the next view. It costs a bundle load per render and interaction,
  about 50 ms with the real bundle ([render a view](render-a-view.md)).
- **The realm's HTML is untrusted.** The render guard holds only while the
  bundle's renderer is built through `guardRenderer`, and it checks names and
  values, not every way HTML can be read. `GeneratedView` sanitizes the HTML
  and frames it behind the CSP as if no guard had run; another consumer of
  `realm.render` must do the same.
- **A caught engine error can be relabelled.** The captured prototype distinguishes
  ordinary errors from internal errors, but a view that catches a genuine internal
  error after crossing a bound can change its message before rethrowing. The
  reported limit follows the exact message on that internal error.
- **The checker is depth, not the boundary.** A computed property name passes
  it; the realm, the render guard and the frame stand behind it.
- **`detail` is the caller's to guard.** It is redacted so that printing,
  logging or serializing the error shows `<redacted>`, but a caller that
  unwraps it with `Redacted.value` and records the result leaks it. Put it in
  a correction prompt only.
- **An app-wide CSP must carry the runtime's hash.** An `about:srcdoc` frame
  inherits the page's policy too. The app sets none today.

The realm shares portable lifecycle primitives and module quarantine with the
cell sandbox through `QuickJSLifecycle` from `@smthrs/harness`. Presentation
still removes weak references and hardens the bundle independently; sharing
lifecycle code never grants a view the harness host bridge.

`InternalError` is removed, and the realm checks the captured internal error
prototype before trusting a limit message. Ordinary errors retain their own message
in the redacted `detail`, even when it mentions memory or a call stack.

The checker refuses module-level `await` and `for await`, because checked
modules execute in a synchronous factory. Nested async helpers remain valid, but the default export and `reduce` must
be synchronous, non-generator functions. The realm refuses a thenable returned
by `reduce` before serializing state.
Math may be used only through direct, statically named deterministic members;
passing or destructuring the Math object and dynamic member keys are refused.
Forbidden object keys are refused whether identifiers or quoted strings.
Literal interaction decoding and the render guard copy into null-prototype
records, preserving an own `__proto__` as data for validation.
