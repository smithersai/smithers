import { Effect, Metric, Redacted } from "effect"
import * as fc from "fast-check"
import { createHash } from "node:crypto"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as jsxRuntime from "react/jsx-runtime"
import { describe, expect, it } from "vitest"
import { Docs, Presentation, PresentationRealm, ViewCode, ViewCsp, WebPage } from "../src/index.ts"
import { refusedNames, refusedProperties } from "../src/internal/vocabulary.ts"
import { checked, unchecked, withRealm } from "./fixtures/realm.ts"

const check = (source: string) => Effect.runSync(ViewCode.check(source, { components: ["Card"] }))
const refusal = (source: string) => Effect.runSync(Effect.flip(ViewCode.check(source, { components: ["Card"] })))

describe("realm error classification", () => {
  it.each([
    "out of memory",
    "stack overflow",
    "the call stack is shown below",
    "OUT OF MEMORY",
    "stack overflow report"
  ])(
    "preserves an ordinary error: %s",
    async (note) => {
      const module = checked("export default function View({ props }) { throw new Error(props.note) }")
      const error = await withRealm((realm) => Effect.flip(realm.render({ module, props: { note }, state: null })))
      expect(error.reason).toBe("render_failed")
      expect(error.limit).toBeUndefined()
      expect(Redacted.value(error.detail)).toBe("Error: " + note)
    }
  )

  it("does not count ordinary errors as crossed bounds", async () => {
    const deltas = await withRealm((realm) =>
      Effect.gen(function*() {
        const counters = ["memory", "stack"].map((limit) =>
          Metric.withAttributes(PresentationRealm.limitHits, { limit })
        )
        const before = yield* Effect.all(counters.map(Metric.value))
        for (const note of ["out of memory", "stack overflow"]) {
          yield* Effect.flip(realm.render({
            module: checked("export default function View({ props }) { throw new RangeError(props.note) }"),
            props: { note },
            state: null
          }))
        }
        const after = yield* Effect.all(counters.map(Metric.value))
        return after.map((value, index) => value.count - before[index]!.count)
      })
    )
    expect(deltas).toEqual([0, 0])
  })

  it.each(["out of memory", "stack overflow"])("refuses a forged InternalError: %s", async (message) => {
    const module = checked("export default ({ props }) => { throw { name: 'InternalError', message: props.message } }")
    const error = await withRealm((realm) => Effect.flip(realm.render({ module, props: { message }, state: null })))
    expect(error.reason).toBe("render_failed")
    expect(error.limit).toBeUndefined()
    expect(Redacted.value(error.detail)).toBe("InternalError: " + message)
  })

  it("does not trust an Error with a forged name or read its constructor getter", async () => {
    const module = checked(
      "export default () => { const e = new Error('out of memory'); Object.defineProperty(e, 'name', { value: 'InternalError' }); Object.defineProperty(e, 'con' + 'structor', { get() { throw 'getter ran' } }); throw e }"
    )
    const error = await withRealm((realm) => Effect.flip(realm.render({ module, props: {}, state: null })))
    expect(error.reason).toBe("render_failed")
    expect(error.limit).toBeUndefined()
    expect(Redacted.value(error.detail)).toBe("InternalError: out of memory")
  })

  it.each(["null", "undefined"])("preserves thrown %s when its prototype cannot be read", async (value) => {
    const error = await withRealm((realm) =>
      Effect.flip(realm.render({
        module: checked("export default () => { throw " + value + " }"),
        props: {},
        state: null
      }))
    )
    expect(error.reason).toBe("render_failed")
    expect(Redacted.value(error.detail)).toBe(value)
  })

  it("removes the QuickJS InternalError constructor", async () => {
    const html = await withRealm((realm) =>
      realm.render({
        module: unchecked(
          "exports.default = () => require(\"react\").createElement(\"p\", null, typeof InternalError)"
        ),
        props: {},
        state: null
      })
    )
    expect(html).toBe("<p>undefined</p>")
  })
})

describe("synchronous view entry points", () => {
  const view = "export default () => <p>state</p>"
  it.each([
    "export const reduce = async (state) => state + 1",
    "export async function reduce(state) { return state + 1 }",
    "export function* reduce(state) { yield state + 1 }",
    "export async function* reduce(state) { yield state + 1 }",
    "const next = async (state) => state + 1; export { next as reduce }",
    "async function next(state) { return state + 1 }; const alias = next; export { alias as reduce }",
    "const next = (async (state) => state + 1) as any; export const reduce = next",
    "const next = (function* (state) { yield state }) satisfies Function; export { next as reduce }"
  ])("refuses an asynchronous or generator reducer: %s", (source) => {
    expect(Redacted.value(refusal(source + "\n" + view).detail)).toContain(
      "reduce must be a synchronous, non-generator function"
    )
  })

  it("refuses an interactions export without a value", () => {
    expect(Redacted.value(refusal("export let interactions; " + view).detail)).toContain(
      "interactions must be an object literal"
    )
  })

  it.each([
    "export default async () => <p />",
    "export default async function View() { return <p /> }",
    "export default function* View() { yield <p /> }",
    "export default async function* () { yield <p /> }",
    "const View = async () => <p />; export default View",
    "function* View() { yield <p /> }; export { View as default }",
    "const View = (async () => <p />) as any; export default View!",
    "const View = (async () => <p />) satisfies Function; export { View as default }",
    "async function View<T>() { return <p /> }; export default View<number>"
  ])("refuses an asynchronous or generator default: %s", (source) => {
    expect(Redacted.value(refusal(source).detail)).toContain(
      "default must be a synchronous, non-generator function"
    )
  })

  it.each([
    "export default () => { async function helper() { return 1 }; return <p /> }",
    "const View = () => <p />; export default View",
    "function View() { return <p /> }; export { View as default }",
    "const next = (state) => state + 1; export { next as reduce }; " + view,
    "let next; export { next as reduce }; " + view,
    "const { next } = { next: (state) => state }; export { next as reduce }; " + view,
    "const first = second; const second = first; export default first",
    "export default Missing",
    "export default function() { return <p /> }",
    "export default class View {}",
    "export default 1"
  ])("keeps other existing module forms accepted: %s", (source) => {
    expect(check(source).compiled).toBeTypeOf("string")
  })

  const installed = Presentation.make({ react: React, jsxRuntime, renderToStaticMarkup, components: {} })
  const reduce = (value: unknown) =>
    installed.reduce(
      (_require, _module, exports) => {
        exports.reduce = () => value
      },
      "1",
      "{\"name\":\"go\"}"
    )

  it("refuses promises and object or callable thenables before serializing state", () => {
    for (const value of [Promise.resolve(2), { then() {} }, Object.assign(() => 1, { then() {} })]) {
      expect(() => reduce(value)).toThrow("reduce must return state synchronously")
    }
  })

  it.each([null, false, 2, "next", { then: 1 }, {}, [1]])("keeps synchronous JSON state: %j", (value) => {
    expect(reduce(value)).toBe(JSON.stringify(value))
  })

  it("reports a runtime-produced promise as a correction instead of replacing state", async () => {
    const module = checked(
      "export const reduce = (state) => Promise.resolve(state + 1); export default ({ state }) => <p>{JSON.stringify(state)}</p>"
    )
    const error = await withRealm((realm) =>
      Effect.flip(realm.interact({ module, props: {}, state: 1, event: { name: "go" } }))
    )
    expect(error.reason).toBe("render_failed")
    expect(Redacted.value(error.detail)).toBe("TypeError: reduce must return state synchronously")
  })
})

describe("JSX member admission", () => {
  it("refuses every forbidden JSX member property, including nested tags", () => {
    for (const name of refusedProperties) {
      for (const object of ["Card", "Card.Group"]) {
        expect(Redacted.value(
          refusal(
            "import { Card } from \"@smthrs/ui\"; export default () => <" + object + "." + name + " />"
          ).detail
        )).toContain("The property " + name + " is refused in a view")
      }
    }
  })

  it("refuses every forbidden JSX root, including nested tags", () => {
    fc.assert(
      fc.property(fc.constantFrom(...refusedNames), fc.boolean(), (name, nested) => {
        expect(Redacted.value(
          refusal(
            "export default () => <" + name + (nested ? ".Group" : "") + ".View />"
          ).detail
        )).toContain(name + " is refused in a view")
      }),
      { numRuns: 200, examples: [["window", true], ["Function", false]] }
    )
  })

  it("refuses bare forbidden component names while preserving harmless intrinsic tags", () => {
    for (const name of refusedNames) {
      if (/^[A-Z]/.test(name)) {
        expect(Redacted.value(refusal("export default () => <" + name + " />").detail))
          .toContain(name + " is refused in a view")
      }
    }
    expect(check("export default () => <div><window /><fetch /></div>").compiled).toContain("window")
  })

  it("keeps ordinary JSX members and safe React members accepted", () => {
    expect(check("import { Card } from \"@smthrs/ui\"; export default () => <Card.Group />").compiled).toContain(
      "Group"
    )
    expect(check("import React from \"react\"; export default () => <React.Fragment />").compiled).toContain("Fragment")
  })
})

describe("frame runtime text", () => {
  const document = (runtime: string) => ViewCsp.frameDocument({ runtime, styles: "", nonce: "n", theme: "light" })
  it.each(["\r\n", "\r", "\n", "\r\r\n"])("pins HTML-normalized newlines: %j", (newline) => {
    const html = document("var a = 1;" + newline + "var b = '</script>';")
    const expected = "var a = 1;" + newline.replace(/\r\n?/g, "\n") + "var b = '<\\/script>';"
    expect(html).toContain("<script>" + expected + "</script>")
    expect(html).toContain("'sha256-" + createHash("sha256").update(expected).digest("base64") + "'")
  })

  it("refuses NUL instead of hashing text the parser replaces", () => {
    expect(() => document("var a = '\0'")).toThrow("The frame runtime must not contain NUL")
  })
})

describe("docs index Markdown", () => {
  const parse = (lines: ReadonlyArray<string>) => Docs.parse(lines.join("\n"), "https://docs.example.com/llms.txt")
  it("keeps the first non-empty quote as the summary", () => {
    expect(parse(["# T", ">", ">   ", "> Real summary", "> Later summary"]).summary).toBe("Real summary")
    expect(parse([">", ">  "])).toEqual({ title: "", pages: [] })
  })

  it("closes only a matching fence at least as long as the opener, without trailing text", () => {
    fc.assert(
      fc.property(fc.constantFrom("~", "`"), fc.integer({ min: 4, max: 12 }), (character, length) => {
        const open = character.repeat(length)
        const other = (character === "~" ? "`" : "~").repeat(length)
        const result = parse([
          "# T",
          "- [A](/a.md)",
          open + "markdown",
          other,
          "- [Wrong kind](/wrong-kind.md)",
          character.repeat(length - 1),
          "- [Short](/short.md)",
          open + " not a closing fence",
          "- [Trailing](/trailing.md)",
          "plain code",
          "- [Hidden](/hidden.md)",
          open + character,
          "- [C](/c.md)"
        ])
        expect(result.pages.map((page) => page.path)).toEqual(["/a.md", "/c.md"])
      }),
      { numRuns: 100 }
    )
  })

  it("keeps every page after the mixed-fence witness", () => {
    expect(parse(["# T", ">", "> Real summary", "- [A](/a.md)", "~~~", "```", "- [B](/b.md)", "~~~", "- [C](/c.md)"]))
      .toMatchObject({ summary: "Real summary", pages: [{ path: "/a.md" }, { path: "/c.md" }] })
  })

  it("keeps an unclosed fence opaque", () => {
    expect(parse(["~~~md", "- [Hidden](/hidden.md)", "```"]).pages).toEqual([])
  })
})

describe("iframe ancestry", () => {
  it.each([
    {},
    { "content-security-policy": "frame-ancestors 'none'" },
    { "content-security-policy": "frame-ancestors *" },
    { "x-frame-options": "SAMEORIGIN" },
    { "x-frame-options": "DENY" }
  ])("never admits a frame with no ancestors: %j", (headers) => {
    expect(WebPage.framing(headers, { page: "https://docs.example.com/guide", ancestors: [] }))
      .toEqual({ framing: "unknown", reason: "invalid_url" })
  })
})
