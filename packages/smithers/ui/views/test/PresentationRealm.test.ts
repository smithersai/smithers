import singlefile from "@jitl/quickjs-singlefile-browser-release-sync"
import { QuickJSLifecycle, QuickJSVariant } from "@smthrs/harness"
import { Clock, Effect, Layer, Metric, Redacted } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { newVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import { Bridge, PresentationRealm } from "../src/index.ts"
import { bundle } from "./fixtures/bundle.ts"
import { comparison, emptyBoard, ticTacToe } from "./fixtures/modules.ts"
import { layerSingleFile } from "./fixtures/quickjs.ts"
import { checked, unchecked, withRealm } from "./fixtures/realm.ts"

const failure = <A>(effect: Effect.Effect<A, PresentationRealm.RealmError>) => Effect.flip(effect)

/** What the renderer reads: the redacted detail, unwrapped. */
const detailOf = (error: PresentationRealm.RealmError): string => Redacted.value(error.detail)

/** An error's fields with its detail unwrapped, for matching. */
const described = (error: PresentationRealm.RealmError) => ({
  reason: error.reason,
  limit: error.limit,
  message: error.message,
  detail: detailOf(error)
})

/** A compiled module body whose default export renders `body`'s return value. */
const compiled = (body: string) =>
  `"use strict";var _j = require("react/jsx-runtime");exports.default = function View(input) { ${body} };`

describe("PresentationRealm renders in Node", () => {
  it("exposes no host globals even when the checker is bypassed", async () => {
    const names = ["fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "document", "WeakRef", "FinalizationRegistry"]
    const html = await withRealm((realm) =>
      realm.render({
        module: unchecked(
          compiled(`return _j.jsx("p", { children: [${names.map((name) => `typeof ${name}`).join(",")}].join(",") })`)
        ),
        props: {},
        state: null
      })
    )
    expect(html).toBe(`<p>${names.map(() => "undefined").join(",")}</p>`)
  })

  it("has no dynamic import loader in the QuickJS module the realm uses", async () => {
    const module = await QuickJSVariant.compiledModule.pipe(Effect.provide(layerSingleFile), Effect.runPromise)
    const runtime = module.newRuntime()
    const context = runtime.newContext()
    try {
      const promise = context.unwrapResult(context.evalCode("import(\"https://example.invalid/escape.js\")"))
      try {
        const jobs = runtime.executePendingJobs()
        expect(jobs.error).toBeUndefined()
        const state = context.getPromiseState(promise)
        expect(state.type).toBe("rejected")
        if (state.type !== "rejected") throw new Error("Dynamic import unexpectedly admitted")
        try {
          expect(context.dump(state.error)).toMatchObject({
            name: "ReferenceError",
            message: expect.stringContaining("could not load module")
          })
        } finally {
          state.error.dispose()
        }
      } finally {
        promise.dispose()
      }
    } finally {
      context.dispose()
      runtime.dispose()
    }
  })

  it("renders real components, keeping their classes and data-event attributes", async () => {
    const html = await withRealm((realm) =>
      realm.render({ module: checked(ticTacToe), props: { title: "Game" }, state: emptyBoard })
    )
    expect(html).toContain("<div data-slot=\"card\" class=\"sui-card board\">")
    expect(html).toContain("<span data-slot=\"badge\" class=\"sui-badge\">Game · X</span>")
    expect(html.match(/data-event="cell:\d"/g)).toHaveLength(9)
    expect(html).toContain("data-event=\"again\"")
    expect(html).toContain("style=\"display:grid;grid-template-columns:repeat(3, 3rem)\"")
  })

  it("renders tables and SVG exactly", async () => {
    const html = await withRealm((realm) =>
      realm.render({
        module: checked(comparison),
        props: { rows: [{ name: "Postgres", kind: "server" }, { name: "<SQLite>", kind: "file" }] },
        state: null
      })
    )
    expect(html).toBe(
      "<div data-slot=\"card\" class=\"sui-card\"><table><thead><tr><th>Name</th><th>Kind</th></tr></thead><tbody>" +
        "<tr><td>Postgres</td><td>server</td></tr><tr><td>&lt;SQLite&gt;</td><td>file</td></tr></tbody></table>" +
        "<svg viewBox=\"0 0 10 10\" width=\"10\"><circle cx=\"5\" cy=\"5\" r=\"4\" fill=\"currentColor\"></circle></svg></div>"
    )
  })

  it("names the components the bundle carries", async () => {
    expect(await withRealm((realm) => Effect.succeed(realm.components))).toEqual(["Badge", "Button", "Card"])
  })

  it("plays a legal move by changing exactly one cell, and ignores an illegal one", async () => {
    const module = checked(ticTacToe)
    const [first, second] = await withRealm((realm) =>
      Effect.gen(function*() {
        const first = yield* realm.interact({
          module,
          props: { title: "Game" },
          state: emptyBoard,
          event: { name: "cell", arg: "4" }
        })
        const second = yield* realm.interact({
          module,
          props: { title: "Game" },
          state: first.state,
          event: { name: "cell", arg: "4" }
        })
        return [first, second] as const
      })
    )
    expect(first.state).toEqual({ cells: ["", "", "", "", "X", "", "", "", ""], turn: "O" })
    expect(first.html).toContain("Game · O")
    expect(first.html).toContain("data-event=\"cell:4\">X</button>")
    expect(second.state).toEqual(first.state)
  })

  it("renders the same module the same way every time", async () => {
    const module = checked(ticTacToe)
    const renders = await withRealm((realm) =>
      Effect.all(Array.from({ length: 5 }, () => realm.render({ module, props: { title: "G" }, state: emptyBoard })))
    )
    expect(new Set(renders).size).toBe(1)
  })

  it("provides the realm as a layer", async () => {
    const html = await PresentationRealm.PresentationRealm.pipe(
      Effect.flatMap((realm) => realm.render({ module: checked(comparison), props: { rows: [] }, state: null })),
      Effect.provide(PresentationRealm.layer({ bundle: await bundle() }).pipe(Layer.provide(layerSingleFile))),
      Effect.runPromise
    )
    expect(html).toContain("<tbody></tbody>")
  })
})

describe("PresentationRealm bounds every render", () => {
  it("stops an infinite loop at its step limit, then renders the next module in a fresh realm", async () => {
    const [error, after] = await withRealm((realm) =>
      Effect.gen(function*() {
        const error = yield* failure(
          realm.render({ module: unchecked(compiled("for (;;) {}")), props: {}, state: null })
        )
        const after = yield* realm.render({ module: checked(comparison), props: { rows: [] }, state: null })
        return [error, after] as const
      }), { limits: { steps: 20 } })
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "steps" })
    expect(after).toContain("<table>")
  })

  it("stops an infinite loop at its time limit", async () => {
    const error = await withRealm(
      (realm) => failure(realm.render({ module: unchecked(compiled("while (true) {}")), props: {}, state: null })),
      { limits: { renderMs: 30, steps: Number.MAX_SAFE_INTEGER } }
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "time" })
  })

  it("stops a loop the module tries to catch its way out of", async () => {
    const error = await withRealm(
      (realm) =>
        failure(
          realm.render({
            module: unchecked(compiled("for (;;) { try { for (;;) {} } catch (e) {} }")),
            props: {},
            state: null
          })
        ),
      { limits: { steps: 20 } }
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "steps" })
  })

  it("stops a memory bomb", async () => {
    const error = await withRealm(
      (realm) =>
        failure(
          realm.render({
            module: unchecked(compiled("const all = []; for (;;) all.push(new Array(100000).fill(all.length))")),
            props: {},
            state: null
          })
        ),
      { limits: { memoryBytes: 16 * 1024 * 1024, steps: Number.MAX_SAFE_INTEGER, renderMs: 30_000 } }
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "memory" })
  })

  it("stops unbounded recursion", async () => {
    const error = await withRealm((realm) =>
      failure(
        realm.render({
          module: unchecked(compiled("const deep = (n) => deep(n + 1) + 1; return deep(0)")),
          props: {},
          state: null
        })
      )
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "stack" })
  })

  it("honors quarantine recorded by another consumer of the compiled module", async () => {
    const variant = QuickJSVariant.layerVariant(newVariant(singlefile as unknown as QuickJSSyncVariant, {}))
    const result = await Effect.gen(function*() {
      const module = yield* QuickJSVariant.compiledModule
      const realm = yield* PresentationRealm.make({ bundle: yield* Effect.promise(() => bundle()) })
      // The shared lifecycle seam records the same event as a harness overflow.
      QuickJSLifecycle.abandon(module)
      const existing = yield* failure(realm.render({ module: checked(comparison), props: { rows: [] }, state: null }))
      const fresh = yield* Effect.flip(PresentationRealm.make({ bundle: "" }))
      return { existing, fresh }
    }).pipe(Effect.scoped, Effect.provide(variant), Effect.runPromise)
    expect(result.existing).toMatchObject({ reason: "load_failed" })
    expect(result.fresh).toMatchObject({ reason: "load_failed" })
  })

  it("quarantines a module after host stack overflow instead of leaking more runtimes", async () => {
    // A stack bound larger than the host's lets the host overflow first. A
    // variant of its own keeps the damaged module away from the other tests.
    const variant = QuickJSVariant.layerVariant(newVariant(singlefile as unknown as QuickJSSyncVariant, {}))
    const [error, after] = await withRealm((realm) =>
      Effect.gen(function*() {
        const error = yield* failure(
          realm.render({
            module: unchecked(compiled("const deep = (n) => deep(n + 1) + 1; return deep(0)")),
            props: {},
            state: null
          })
        )
        const after = yield* failure(realm.render({ module: checked(comparison), props: { rows: [] }, state: null }))
        return [error, after] as const
      }), { limits: { stackBytes: 1024 * 1024 }, variant })
    expect(described(error)).toMatchObject({
      reason: "limit_exceeded",
      limit: "stack",
      message: "The view crossed its stack limit",
      detail: "The view overflowed the host's stack"
    })
    expect(after).toMatchObject({ reason: "load_failed" })
    const again = await Effect.gen(function*() {
      return yield* Effect.flip(PresentationRealm.make({ bundle: yield* Effect.promise(() => bundle()) }))
    }).pipe(Effect.scoped, Effect.provide(variant), Effect.runPromise)
    expect(again).toMatchObject({ reason: "load_failed" })
  })

  it("bounds reduce output before parsing host JSON", async () => {
    const source = `globalThis.__smithersPresentation = { components: [], render: () => "", reduce: () => "x".repeat(${
      Bridge.maxStateBytes + 1
    }) }`
    const error = await withRealm((realm) =>
      failure(realm.interact({
        module: unchecked(""),
        props: {},
        state: null,
        event: { name: "go" }
      })), { bundle: source })
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "state" })
  })

  it("refuses HTML over the bridge's bound", async () => {
    const big = `return _j.jsx("p", { children: "x".repeat(${Bridge.maxHtmlBytes}) })`
    const [error, after] = await withRealm((realm) =>
      Effect.gen(function*() {
        const error = yield* failure(realm.render({ module: unchecked(compiled(big)), props: {}, state: null }))
        const after = yield* realm.render({ module: checked(comparison), props: { rows: [] }, state: null })
        return [error, after] as const
      })
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "html" })
    expect(after).toContain("<table>")
  })

  it("refuses props and state over their bounds, and values that are not JSON", async () => {
    const module = checked(comparison)
    const errors = await withRealm((realm) =>
      Effect.all([
        failure(realm.render({ module, props: { rows: [], pad: "x".repeat(300 * 1024) }, state: null })),
        failure(realm.render({ module, props: { rows: [] }, state: "x".repeat(Bridge.maxStateBytes) })),
        failure(realm.render({ module, props: { rows: [], n: 1n }, state: null })),
        failure(realm.render({ module, props: undefined, state: null }))
      ])
    )
    expect(errors.map((error) => [error.reason, error.limit])).toEqual([
      ["limit_exceeded", "props"],
      ["limit_exceeded", "state"],
      ["invalid_input", undefined],
      ["invalid_input", undefined]
    ])
    expect(detailOf(errors[2]!)).toBe("The view's props must be JSON")
    expect(errors[2]!.message).toBe("The view's props, state or event is not JSON")
  })

  it("refuses state reduce returns over the bound", async () => {
    const source = `export const interactions = { grow: { kind: "state" } }
export const reduce = (state: string) => state + "x".repeat(${Bridge.maxStateBytes})
export default function View() { return <p data-event="grow">grow</p> }`
    const module = checked(source)
    const error = await withRealm((realm) =>
      failure(realm.interact({ module, props: {}, state: "", event: { name: "grow" } }))
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "state" })
  })

  it("counts each crossed bound by limit", async () => {
    const steps = Metric.withAttributes(PresentationRealm.limitHits, { limit: "steps" })
    const counted = await withRealm((realm) =>
      Effect.gen(function*() {
        const before = yield* Metric.value(steps)
        yield* failure(realm.render({ module: unchecked(compiled("for (;;) {}")), props: {}, state: null }))
        yield* failure(realm.render({ module: checked(comparison), props: undefined, state: null }))
        const after = yield* Metric.value(steps)
        return after.count - before.count
      }), { limits: { steps: 20 } })
    expect(counted).toBe(1)
  })
})

describe("PresentationRealm reports what a module got wrong", () => {
  const renderError = (module: ReturnType<typeof unchecked>) =>
    withRealm((realm) => failure(realm.render({ module, props: {}, state: null }))).then(described)

  it("a thrown error, by name and message", async () => {
    expect(await renderError(unchecked(compiled("throw new RangeError('no board')")))).toMatchObject({
      reason: "render_failed",
      message: "The view's module failed",
      detail: "RangeError: no board"
    })
    expect(await renderError(unchecked(compiled("throw 'plain'")))).toMatchObject({
      reason: "render_failed",
      detail: "plain"
    })
    expect(await renderError(unchecked(compiled("throw { name: undefined, message: 'bare' }")))).toMatchObject({
      reason: "render_failed",
      detail: "bare"
    })
  })

  it("in a redacted detail, never in the error's message, stack or printed form", async () => {
    const error = await withRealm((realm) =>
      failure(realm.render({ module: unchecked(compiled("throw new Error('private words')")), props: {}, state: null }))
    )
    expect(detailOf(error)).toBe("Error: private words")
    expect(error.message).toBe("The view's module failed")
    for (const printed of [String(error), JSON.stringify(error), String(error.stack), String(error.detail)]) {
      expect(printed).not.toContain("private words")
    }
  })

  it("a module that does not compile in the realm", async () => {
    expect(await renderError(unchecked("exports.default = ;"))).toMatchObject({ reason: "render_failed" })
  })

  it("a default export that is not a component", async () => {
    expect(await renderError(unchecked("exports.default = 1"))).toMatchObject({
      reason: "render_failed",
      detail: "TypeError: The module's default export must be a component"
    })
  })

  it("an import outside the three modules", async () => {
    expect(await renderError(unchecked("require('fs')"))).toMatchObject({
      reason: "render_failed",
      detail: "Error: A view may import only react, @smthrs/ui and smithers:view, not fs"
    })
  })

  it("a refused element or attribute built where the checker cannot see it", async () => {
    const script = "const t = ['scr', 'ipt'].join(''); return _j.jsx(t, {})"
    expect(await renderError(unchecked(compiled(script)))).toMatchObject({
      detail: "Error: <script> is refused in a view"
    })
    const spread = checked(`export default function View() {
  const raw = { ["dangerously" + "SetInnerHTML"]: { __html: "<img src=x onerror=alert(1)>" } }
  return <div {...raw} />
}`)
    expect(await renderError(spread)).toMatchObject({
      detail: "Error: `dangerouslySetInnerHTML` is refused in a view"
    })
  })

  it("a refused element or attribute in an element the constructors never checked, as React emits it", async () => {
    const forged = (type: string, props: string) =>
      `({ $$typeof: _j.jsx("p", {}).$$typeof, type: ${type}, key: null, ref: null, props: ${props} })`
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`return ${forged("'scr' + 'ipt'", "{ children: 'alert(1)' }")}`, "Error: <script> is refused in a view"],
      [
        `return { $$typeof: Symbol.for("react.transitional.element"), type: "img", key: null, ref: null, props: { src: "https://evil.example/p.png" } }`,
        "Error: `src` is allowed only on <img>, as a data:image URL"
      ],
      [
        `return _j.jsx("div", { children: [_j.jsx("p", {}), ${forged("'scr' + 'ipt'", "{}")}] })`,
        "Error: <script> is refused in a view"
      ],
      [
        `const props = {}; const element = _j.jsx("div", props);
         props["dangerously" + "SetInnerHTML"] = { __html: "<img src=x onerror=alert(1)>" }; return element`,
        "Error: `dangerouslySetInnerHTML` is refused in a view"
      ],
      [
        `const element = _j.jsx("p", {}); element.type = "scr" + "ipt"; return element`,
        "Error: <script> is refused in a view"
      ],
      [
        `let reads = 0
         return _j.jsx("img", { alt: "", get src() { return reads++ === 0 ? "data:image/png;base64,AA" : "https://evil.example/p.png" } })`,
        "Error: `src` is allowed only on <img>, as a data:image URL"
      ]
    ]
    for (const [body, detail] of cases) {
      expect(await renderError(unchecked(compiled(body)))).toMatchObject({ reason: "render_failed", detail })
    }
  })

  it("an interaction on a module with no reduce, or a reduce that returns nothing", async () => {
    const errors = await withRealm((realm) =>
      Effect.all([
        failure(
          realm.interact({
            module: checked(ticTacToe),
            props: 1n,
            state: emptyBoard,
            event: { name: "cell", arg: "1" }
          })
        ),
        failure(
          realm.interact({
            module: unchecked(
              "exports.reduce = (s) => s + 1; exports.default = (input) => { throw new Error('state ' + input.state) }"
            ),
            props: {},
            state: 1,
            event: { name: "x" }
          })
        ),
        failure(
          realm.interact({ module: checked(comparison), props: { rows: [] }, state: null, event: { name: "x" } })
        ),
        failure(
          realm.interact({
            module: unchecked("exports.reduce = () => undefined"),
            props: {},
            state: null,
            event: { name: "x" }
          })
        )
      ])
    )
    expect(errors.map(detailOf)).toEqual([
      "The view's props must be JSON",
      "Error: state 2",
      "TypeError: The module exports no reduce function",
      "TypeError: reduce returned no state"
    ])
  })
})

describe("PresentationRealm keeps views apart", () => {
  it("leaves no clock or randomness in the realm", async () => {
    const html = await withRealm((realm) =>
      realm.render({
        module: unchecked(
          compiled("return _j.jsx('p', { children: [typeof Date, typeof Math.random, typeof Proxy].join() })")
        ),
        props: {},
        state: null
      })
    )
    expect(html).toBe("<p>undefined,undefined,undefined</p>")
  })

  it("refuses a module that changes a shared object, so the next module renders as if it never ran", async () => {
    const poisons = [
      "Array['proto' + 'type'].map = function () { return ['pwned'] }",
      "Object['proto' + 'type'].polluted = 'yes'",
      "globalThis.injected = 1",
      "require('@smthrs/ui').Card = function () { return 'pwned' }",
      "require('react/jsx-runtime').jsx = function () { return null }",
      "require('react').createElement = null",
      "JSON.parse = function () { return {} }",
      "require('react').Children.toArray = function (children) { return children }",
      "require('react').Children.captured = 'yes'",
      "require('@smthrs/ui').Card.x = 'mailbox'",
      "require('react').createElement.x = 1",
      "require('react').isValidElement.x = 1",
      "require('react/jsx-runtime').jsx.x = 1",
      "require('smithers:view').event.x = 1",
      "require.x = 1"
    ]
    const results = await withRealm((realm) =>
      Effect.gen(function*() {
        const errors = []
        for (const poison of poisons) {
          errors.push(
            yield* failure(
              realm.render({ module: unchecked(compiled(`${poison}; return null`)), props: {}, state: null })
            )
          )
        }
        const clean = yield* realm.render({
          module: checked(comparison),
          props: { rows: [{ name: "a", kind: "b" }] },
          state: null
        })
        const probe = yield* realm.render({
          module: unchecked(compiled("return _j.jsx('p', { children: String(({}).polluted) + typeof injected })")),
          props: {},
          state: null
        })
        return { errors, clean, probe }
      })
    )
    for (const error of results.errors) {
      expect(described(error)).toMatchObject({ reason: "render_failed", detail: expect.stringMatching(/^TypeError/) })
    }
    expect(results.clean).toContain("<td>a</td><td>b</td>")
    expect(results.probe).toBe("<p>undefinedundefined</p>")
  })

  it("keeps one view from reading another's props, through a facade or what calling a component reaches", async () => {
    // Every channel a view could leave behind: a facade it changes, and the
    // internal Slot that calling Button returns, which no freeze can reach.
    const poisoner = unchecked(compiled(`
      const ui = require("@smthrs/ui")
      const react = require("react")
      const slot = ui.Button({ asChild: true, children: null }).type
      const render = slot.render
      const attempts = [
        () => { slot.render = function (props, ref) { slot.seen = JSON.stringify(props.children.props); return render(props, ref) } },
        () => { const toArray = react.Children.toArray; react.Children.toArray = function (c) { react.Children.seen = JSON.stringify(c); return toArray(c) } },
        () => { ui.Card.seen = "mailbox" }
      ]
      for (const attempt of attempts) { try { attempt() } catch (error) {} }
      return null`))
    const victim = checked(`import { Children } from "react"
import { Button } from "@smthrs/ui"
export default function View({ props }: { props: { secret: string } }) {
  return <Button asChild><span>{Children.toArray([props.secret])}</span></Button>
}`)
    const reader = unchecked(compiled(`
      const ui = require("@smthrs/ui")
      const seen = [ui.Button({ asChild: true, children: null }).type.seen, require("react").Children.seen, ui.Card.seen]
      return _j.jsx("p", { children: seen.map(String).join() })`))
    const [shown, read] = await withRealm((realm) =>
      Effect.gen(function*() {
        yield* realm.render({ module: poisoner, props: {}, state: null })
        const shown = yield* realm.render({ module: victim, props: { secret: "OTHER_PERSONS_SECRET" }, state: null })
        const read = yield* realm.render({ module: reader, props: {}, state: null })
        return [shown, read] as const
      })
    )
    expect(shown).toBe("<span data-slot=\"button\" class=\"sui-button\">OTHER_PERSONS_SECRET</span>")
    expect(read).toBe("<p>undefined,undefined,undefined</p>")
  })
})

describe("PresentationRealm loads its bundle", () => {
  it("fails a bundle that throws, or installs no renderer", async () => {
    const thrown = await Effect.runPromise(
      Effect.flip(PresentationRealm.make({ bundle: "throw new Error('broken bundle')" })).pipe(
        Effect.scoped,
        Effect.provide(layerSingleFile)
      )
    )
    expect(described(thrown)).toMatchObject({
      reason: "load_failed",
      message: "The presentation bundle did not load",
      detail: "Error: broken bundle"
    })
    const empty = await Effect.runPromise(
      Effect.flip(PresentationRealm.make({ bundle: "globalThis.__smithersPresentation = { render: 1, reduce: 2 }" }))
        .pipe(Effect.scoped, Effect.provide(layerSingleFile))
    )
    expect(described(empty)).toMatchObject({
      reason: "load_failed",
      detail: "The bundle did not install __smithersPresentation"
    })
  })

  it("fails a bundle whose renderer emits an element the guard never saw", async () => {
    const error = await Effect.runPromise(
      Effect.flip(PresentationRealm.make({ bundle: await bundle({ guarded: false }) })).pipe(
        Effect.scoped,
        Effect.provide(layerSingleFile)
      )
    )
    expect(described(error)).toMatchObject({
      reason: "load_failed",
      detail: "Error: The bundle's renderer does not guard what it emits; build it with guardRenderer"
    })
  })

  it("reads the component names a bundle reports, if any", async () => {
    const minimal = "globalThis.__smithersPresentation = { render() { return '' }, reduce() { return 'null' }"
    const names = await Effect.runPromise(
      Effect.all([
        PresentationRealm.make({ bundle: `${minimal} }` }),
        PresentationRealm.make({ bundle: `${minimal}, components: ["Card", 1, null, "Badge"] }` })
      ]).pipe(
        Effect.map((realms) => realms.map((realm) => realm.components)),
        Effect.scoped,
        Effect.provide(layerSingleFile)
      )
    )
    expect(names).toEqual([[], ["Card", "Badge"]])
  })

  it("fails a bundle that runs past its load limit", async () => {
    const error = await Effect.runPromise(
      Effect.flip(PresentationRealm.make({ bundle: "for (;;) {}", limits: { loadMs: 30 } })).pipe(
        Effect.scoped,
        Effect.provide(layerSingleFile)
      )
    )
    expect(error).toMatchObject({ reason: "limit_exceeded", limit: "time" })
  })

  it("propagates a later load timeout and recovers on the following render", async () => {
    const source = await bundle()
    let now = 0
    let expires = false
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => {
        const current = now
        if (expires) now += 31
        return current
      },
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      sleep: (duration) => Clock.Clock.defaultValue().sleep(duration)
    }
    const input = { module: checked(comparison), props: { rows: [] }, state: null }
    const [before, error, after] = await Effect.gen(function*() {
      const realm = yield* PresentationRealm.make({ bundle: source, limits: { loadMs: 30 } })
      const before = yield* realm.render(input)
      expires = true
      const error = yield* failure(realm.render(input))
      expires = false
      const after = yield* realm.render(input)
      return [before, error, after] as const
    }).pipe(
      Effect.scoped,
      Effect.provide(layerSingleFile),
      Effect.provideService(Clock.Clock, clock),
      Effect.runPromise
    )
    expect(before).toContain("<table>")
    expect(described(error)).toMatchObject({
      reason: "limit_exceeded",
      limit: "time",
      message: "The view crossed its time limit",
      detail: "The view ran past its time limit"
    })
    expect(after).toBe(before)
  })

  it("fails when QuickJS cannot be compiled", async () => {
    const broken = {
      type: "sync",
      importFFI: () => Promise.reject(new Error("no ffi")),
      importModuleLoader: () => Promise.reject(new Error("no loader"))
    } as unknown as QuickJSSyncVariant
    const error = await Effect.runPromise(
      Effect.flip(PresentationRealm.make({ bundle: await bundle() })).pipe(
        Effect.scoped,
        Effect.provide(QuickJSVariant.layerVariant(broken))
      )
    )
    expect(described(error)).toMatchObject({
      reason: "load_failed",
      detail: expect.stringMatching(/^QuickJS could not be compiled/)
    })
  })

  it("refuses to render once its scope has closed", async () => {
    const realm = await Effect.runPromise(
      PresentationRealm.make({ bundle: await bundle() }).pipe(Effect.scoped, Effect.provide(layerSingleFile))
    )
    const error = await Effect.runPromise(
      Effect.flip(realm.render({ module: checked(comparison), props: { rows: [] }, state: null }))
    )
    expect(described(error)).toMatchObject({
      reason: "load_failed",
      detail: "The realm is closed or its QuickJS module is quarantined"
    })
  })
})
