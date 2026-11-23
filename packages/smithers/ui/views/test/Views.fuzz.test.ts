import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as jsxRuntime from "react/jsx-runtime"
import { describe, expect, it } from "vitest"
import { Bridge, Docs, Home, Interactions, Presentation, ViewCode, ViewCsp, WebPage } from "../src/index.ts"
import { harden } from "../src/internal/harden.ts"
import { checked, unchecked, withRealm } from "./fixtures/realm.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

const ForbiddenSnippets = [
  "eval(\"1\")",
  "new Function(\"return 1\")()",
  "globalThis.fetch(\"https://evil.example\")",
  "window.location.href",
  "document.cookie",
  "process.env.SECRET",
  "fetch(\"https://evil.example\")",
  "import(\"node:fs\")",
  "({}).constructor.constructor(\"return this\")()",
  "Reflect.get(globalThis, \"process\")"
] as const

const ForbiddenElements = ["script", "iframe", "a", "style", "object", "embed", "meta", "link", "base"] as const
const ForbiddenAttrs = ["href", "src", "dangerouslySetInnerHTML", "onClick", "formAction", "xlink:href"] as const

describe("@smthrs/views ViewCode, ViewCsp, Interactions & Bridge fuzz invariants", () => {
  it("ViewCode.check ALWAYS refuses sandbox-escapes, forbidden elements/attrs/imports, accepts valid modules & compiles", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        escapeIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: ForbiddenSnippets.length - 1 }))
        ),
        elIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: ForbiddenElements.length - 1 }))),
        attrIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: ForbiddenAttrs.length - 1 }))),
        label: Schema.Literals(["Hello", "Count", "Status", "Item 1"]),
        withReducer: Schema.Boolean,
        noise: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        raw: Schema.String.pipe(Schema.check(Schema.isMaxLength(120)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ escapeIdx, elIdx, attrIdx, label, withReducer, noise, raw }) =>
          Effect.gen(function*() {
            // 1. Sandbox escape refused
            const snippet = ForbiddenSnippets[escapeIdx]!
            const malicious =
              `import React from "react"\nexport default function View() { const x = ${snippet}; return <div>{String(x)}</div> }`
            const checkedMal = yield* Effect.result(ViewCode.check(malicious, { components: ["Card"] }))
            if (Result.isSuccess(checkedMal) || checkedMal.failure._tag !== "@smthrs/views/ViewCodeError") return false

            // 2. Forbidden element & attribute refused
            const el = ForbiddenElements[elIdx]!
            const badEl = `export default function View() { return <${el}>x</${el}> }`
            const elRes = yield* Effect.result(ViewCode.check(badEl, { components: ["Card"] }))
            if (Result.isSuccess(elRes)) return false

            const attr = ForbiddenAttrs[attrIdx]!
            const badAttr = `export default function View() { return <div ${attr}="x" /> }`
            const attrRes = yield* Effect.result(ViewCode.check(badAttr, { components: ["Card"] }))
            if (Result.isSuccess(attrRes)) return false

            // 3. Valid TSX module with data-image img, interactions & optional reducer succeeds
            const validSource = [
              `import { Card } from "@smthrs/ui"`,
              withReducer
                ? `export const interactions = { tap: { kind: "state" }, send: { kind: "message", label: "Send" } } as const`
                : `export const interactions = { send: { kind: "message", label: "Send" } } as const`,
              ...(withReducer
                ? [`export function reduce(state: number, event: { name: string }) { return (state ?? 0) + 1 }`]
                : []),
              `export default function View({ props }: { props: { n?: number } }) {`,
              `  return <Card><img src="data:image/png;base64,AA==" alt="ok" /><button data-event="send">${label}</button></Card>`,
              `}`
            ].join("\n")
            const okRes = yield* Effect.result(ViewCode.check(validSource, { components: ["Card"] }))
            if (Result.isFailure(okRes)) return false
            if (okRes.success.reduces !== withReducer) return false
            if (!("send" in okRes.success.interactions)) return false

            // 4. Disallowed import refused
            const badImport = `import x from ${
              JSON.stringify(noise || "node:fs")
            }\nexport default function View() { return <div /> }`
            const badImportRes = yield* Effect.result(ViewCode.check(badImport, { components: ["Card"] }))
            if (
              Result.isSuccess(badImportRes) &&
              !ViewCode.modules.includes(noise as (typeof ViewCode.modules)[number])
            ) {
              return false
            }

            // 5. Arbitrary garbage never throws a defect
            const arbitraryRes = yield* Effect.result(ViewCode.check(raw, { components: ["Card"] }))
            return Result.isSuccess(arbitraryRes) || arbitraryRes.failure._tag === "@smthrs/views/ViewCodeError"
          }),
        { seed, executions }
      )
    )
    assertPassed(report)

    // Non-data img src refused
    const badImg = await Effect.runPromise(
      Effect.result(
        ViewCode.check(`export default function View() { return <img src="https://evil.example/p.png" /> }`, {
          components: []
        })
      )
    )
    expect(Result.isFailure(badImg)).toBe(true)
  })

  it("Interactions, ViewCsp.frameDocument & Bridge.receive enforce round-trip, CSP escaping, clamping & rate limits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["click", "submit", "select_item", "toggle-1", "a"]),
        arg: Schema.Union([Schema.Undefined, Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))]),
        theme: Bridge.Theme,
        runtimeText: Schema.Literals([
          "console.log(1)",
          "const s = '</script><script>alert(1)</script>';\r\nvar x = 1;",
          "/* safe */"
        ]),
        reportedHeight: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -100, maximum: 2000 }))),
        burstCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 14 }))),
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
      })
    )
    const declared: Interactions.Declared = {
      click: { kind: "state" },
      submit: { kind: "message", label: "Submit" },
      select_item: { kind: "state" },
      "toggle-1": { kind: "state" },
      a: { kind: "state" }
    }
    const nonce = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9"

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, arg, theme, runtimeText, reportedHeight, burstCount, garbage }) =>
          Effect.sync(() => {
            if (arg !== undefined && !isWellFormed(arg)) return true
            if (!isWellFormed(garbage)) return true

            // Interactions round-trip & lookup
            const cleanArg = arg === undefined ? undefined : arg.slice(0, Interactions.maxArgLength)
            const ev: Interactions.Event = cleanArg === undefined ? { name } : { name, arg: cleanArg }
            const formatted = Interactions.format(ev)
            const parsed = Interactions.parse(formatted)
            if (Option.isNone(parsed) || parsed.value.name !== name || parsed.value.arg !== cleanArg) return false
            if (Option.isNone(Interactions.lookup(declared, name))) return false
            if (Option.isSome(Interactions.lookup(declared, "undeclared_xyz"))) return false
            const g = Interactions.parse(garbage)
            if (!Option.isSome(g) && !Option.isNone(g)) return false

            // ViewCsp.hash, policy & frameDocument
            const doc = ViewCsp.frameDocument({
              runtime: runtimeText,
              nonce,
              theme,
              styles: "body { color: red; } </style><script>bad</script>"
            })
            if (!doc.includes("default-src &#39;none&#39;") && !doc.includes("default-src 'none'")) return false
            if (doc.includes("</script><script>")) return false
            if (doc.includes("</style><script>")) return false

            // Bridge.acceptInitialize, initializeResult, hostContextChanged, inlineFrameHeight
            const initMsg = {
              jsonrpc: "2.0",
              id: 1,
              method: "ui/initialize",
              params: { nonce }
            }
            const accepted = Bridge.acceptInitialize(initMsg, nonce)
            if (Option.isNone(accepted)) return false
            if (Option.isSome(Bridge.acceptInitialize(initMsg, "wrongNonceValue1234567890"))) return false
            const res = Bridge.initializeResult(accepted.value, { theme, size: "inline", html: "<p>hi</p>" })
            if (res.id !== 1) return false
            const changed = Bridge.hostContextChanged({ theme })
            if (changed.method !== "ui/notifications/host-context-changed") return false

            const clamped = Bridge.inlineFrameHeight(reportedHeight)
            if (clamped < Bridge.inlineHeight.min || clamped > Bridge.inlineHeight.max) return false

            // Bridge.receive: resize, malformed, undeclared, rate limit
            const resize = Bridge.receive({
              message: {
                jsonrpc: "2.0",
                method: "ui/notifications/size-changed",
                params: { height: Math.max(0, reportedHeight) }
              },
              declared,
              window: [],
              now: 1000
            })
            if (resize.verdict._tag !== "Resize") return false

            const bad = Bridge.receive({ message: { bogus: 1 }, declared, window: [], now: 1000 })
            if (bad.verdict._tag !== "Refused" || bad.verdict.reason !== "malformed") return false

            const und = Bridge.receive({
              message: { jsonrpc: "2.0", method: "smithers/interaction", params: { event: "nope", values: {} } },
              declared,
              window: [],
              now: 1000
            })
            if (und.verdict._tag !== "Refused" || und.verdict.reason !== "undeclared") return false

            let win: Bridge.RateWindow = []
            for (let i = 0; i < burstCount; i++) {
              const step = Bridge.receive({
                message: {
                  jsonrpc: "2.0",
                  method: "smithers/interaction",
                  params: { event: name, ...(cleanArg === undefined ? {} : { arg: cleanArg }), values: { k: i } }
                },
                declared,
                window: win,
                now: 10_000 + i
              })
              win = step.window
              if (i < Bridge.maxInteractionsPerSecond) {
                if (step.verdict._tag !== "State" && step.verdict._tag !== "Message") return false
              } else {
                if (step.verdict._tag !== "Refused" || step.verdict.reason !== "rate_limited") return false
              }
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)

    // NUL in runtime throws TypeError; oversized values refused too_large
    expect(() => ViewCsp.frameDocument({ runtime: "a\0b", nonce, theme: "dark", styles: "" })).toThrow(TypeError)
    const tooBig = Bridge.receive({
      message: {
        jsonrpc: "2.0",
        method: "smithers/interaction",
        params: { event: "click", values: { huge: "x".repeat(Bridge.maxValuesBytes + 10) } }
      },
      declared,
      window: [],
      now: 1000
    })
    expect(tooBig.verdict).toEqual({ _tag: "Refused", reason: "too_large" })
  })
})

describe("@smthrs/views Home, Docs, WebPage & PresentationRealm fuzz invariants", () => {
  it("Home.read/sees/visible/widen & Docs.parse/find/search satisfy schema, audience & XSS-free invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        viewer: Home.Audience,
        sectionAudience: Home.Audience,
        contributors: Home.Contributors,
        injectHtml: Schema.Boolean,
        includeUnknownBlock: Schema.Boolean,
        useLegacyBlocks: Schema.Boolean,
        query: Schema.Literals(["getting started", "api", "guide", "nonexistent_xyz", ""])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ viewer, sectionAudience, contributors, injectHtml, includeUnknownBlock, useLegacyBlocks, query }) =>
          Effect.sync(() => {
            const title = injectHtml ? "<script>alert(1)</script>" : "Welcome"
            const blocks: Array<unknown> = [
              { type: "text", title, text: "Plain overview text." },
              { type: "links", links: [{ label: "Docs", url: "https://docs.example.com/guide" }] },
              { type: "flows", title: "Flows" },
              { type: "prompt", flow: "ask", title: "Ask" },
              { type: "app", flow: "review", title: "Review", picture: "review" },
              ...(includeUnknownBlock ? [{ type: "future-widget-v9", payload: 1 }] : [])
            ]
            const doc = useLegacyBlocks
              ? { blocks, contributors, docs: "https://docs.example.com/llms.txt" }
              : {
                contributors,
                docs: "https://docs.example.com/llms.txt",
                sections: [{ title: "Main", audience: sectionAudience, blocks }]
              }
            const read = Home.read(JSON.stringify(doc))
            if (injectHtml) {
              if (read._tag !== "Invalid") return false
            } else {
              if (read._tag !== "Declared") return false
              if (includeUnknownBlock && read.skipped !== 1) return false
              const widened = Home.widen(viewer, contributors)
              const vis = Home.visible(read.sections, widened)
              const targetAud = useLegacyBlocks ? "everyone" : sectionAudience
              if (Home.sees(widened, targetAud) !== (vis.length === 1)) return false
            }

            // Docs.parse, find, search
            const llmsTxt = [
              "# Product Docs",
              "",
              "## Guides",
              "- [Getting Started](/guides/start.md): Quickstart guide for new users.",
              "- [API Reference](https://docs.example.com/api.md): Full API docs.",
              "- [Bad Scheme](javascript:alert(1)): Should be ignored.",
              "- [Duplicate](/guides/start.md): Ignored dup."
            ].join("\n")
            const index = Docs.parse(llmsTxt, "https://docs.example.com/llms.txt")
            if (index.pages.length !== 2) return false
            if (Docs.find(index, "/guides/start.md") === undefined) return false
            const found = Docs.search(index, query, 5)
            if (query === "nonexistent_xyz" && found.length !== 0) return false
            if (query === "api" && (found.length === 0 || found[0]!.path !== "/api.md")) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)

    // Invalid Home inputs
    expect(Home.read("not json")._tag).toBe("Invalid")
    expect(Home.read("[]")._tag).toBe("Invalid")
    expect(Home.read(JSON.stringify({ sections: Array.from({ length: 10 }, () => ({ blocks: [] })) }))._tag).toBe(
      "Invalid"
    )
  })

  it("WebPage.framing/content/preview & SSRF-guarded WebPage.check / Docs.fetchText enforce framing and host policies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        xfo: Schema.Literals(["", "DENY", "SAMEORIGIN", "ALLOWALL", "DENY, SAMEORIGIN"]),
        csp: Schema.Literals([
          "",
          "frame-ancestors 'none'",
          "frame-ancestors 'self'",
          "frame-ancestors https://app.smithers.sh",
          "frame-ancestors https://*.smithers.sh",
          "frame-ancestors *",
          "default-src 'self'"
        ]),
        ancestor: Schema.Literals(["https://app.smithers.sh", "https://docs.example.com", "https://evil.example"]),
        contentType: Schema.Literals(["text/html; charset=utf-8", "application/xhtml+xml", "application/json", ""]),
        title: Schema.Literals(["My Page &amp; Guide", "<b>Bold</b>", ""])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ xfo, csp, ancestor, contentType, title }) =>
          Effect.sync(() => {
            const headers: Record<string, string> = {}
            if (xfo !== "") headers["x-frame-options"] = xfo
            if (csp !== "") headers["content-security-policy"] = csp
            const result = WebPage.framing(headers, { page: "https://docs.example.com/p", ancestors: [ancestor] })
            if (result.framing !== "allowed" && result.framing !== "refused") return false
            if (csp === "frame-ancestors 'none'" && result.framing !== "refused") return false
            if (csp === "frame-ancestors *" && result.framing !== "allowed") return false
            // CSP frame-ancestors overrides X-Frame-Options!
            if (csp === "frame-ancestors https://app.smithers.sh" && ancestor === "https://app.smithers.sh") {
              if (result.framing !== "allowed") return false
            }

            const showable = WebPage.content({ "content-type": contentType })
            if (
              showable !== !["application/pdf", "application/octet-stream"].includes(contentType.split(";")[0]!.trim())
            ) {
              return false
            }

            const html =
              `<!doctype html><html><head><title>${title}</title><meta property="og:description" content="Desc &quot;ok&quot;"><link rel="icon" href="/fav.png"></head><body>Hi</body></html>`
            const prev = WebPage.preview(html, "https://docs.example.com/sub/page")
            if (prev.description !== "Desc \"ok\"") return false
            if (prev.icon !== "https://docs.example.com/fav.png") return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)

    // Drive Docs.fetchText and WebPage.check through FetchHttpClient with injected Fetch service
    const fetchLayer = FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch)(async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith("/redirect-ok")) {
            return new Response(null, { status: 302, headers: { location: "/page.html" } })
          }
          if (url.endsWith("/redirect-loop")) {
            return new Response(null, { status: 302, headers: { location: "/redirect-loop" } })
          }
          if (url.endsWith("/redirect-private")) {
            return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } })
          }
          if (url.endsWith("/page.html")) {
            return new Response(
              `<!doctype html><html><head><title>Hello</title><meta name="description" content="World"><link rel="icon" href="/icon.png"></head><body>ok</body></html>`,
              { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
            )
          }
          if (url.endsWith("/denied.html")) {
            return new Response("<html><title>No</title></html>", {
              status: 200,
              headers: { "content-type": "text/html", "x-frame-options": "DENY" }
            })
          }
          if (url.endsWith("/icon.png")) {
            return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
              status: 200,
              headers: { "content-type": "image/png" }
            })
          }
          if (url.endsWith("/llms.txt")) {
            return new Response("# Docs\n- [Guide](/guide.md)\n", {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" }
            })
          }
          if (url.endsWith("/binary")) {
            return new Response(new Uint8Array([0x61, 0x00, 0x62]), {
              status: 200,
              headers: { "content-type": "text/plain" }
            })
          }
          if (url.endsWith("/pdf")) {
            return new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })
          }
          if (url.endsWith("/json")) {
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
          }
          if (url.endsWith("/404")) {
            return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
          }
          throw new TypeError("unreachable")
        })
      )
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        // SSRF refusals before sending any request
        expect((yield* Docs.fetchText("http://127.0.0.1/x"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("http://[::1]/x"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("http://foo.local/x"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("file:///etc/passwd"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://user:pass@docs.example.com/x"))._tag).toBe("Refused")

        // Docs.fetchText happy, redirect, loop, private redirect, binary, non-text, 404, unreachable
        const okDoc = yield* Docs.fetchText("https://docs.example.com/llms.txt")
        expect(okDoc._tag).toBe("Text")
        expect((yield* Docs.fetchText("https://docs.example.com/redirect-loop"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://docs.example.com/redirect-private"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://docs.example.com/binary"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://docs.example.com/json"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://docs.example.com/404"))._tag).toBe("Refused")
        expect((yield* Docs.fetchText("https://docs.example.com/neterr"))._tag).toBe("Refused")

        // WebPage.check allowed, denied, redirect, loop, private, non-html, unreachable
        const wpOk = yield* WebPage.check("https://docs.example.com/redirect-ok", {
          ancestors: ["https://app.smithers.sh"]
        })
        expect(wpOk.framing).toBe("allowed")
        expect(wpOk.title).toBe("Hello")
        expect(wpOk.icon?.startsWith("data:image/png;base64,")).toBe(true)

        const wpDenied = yield* WebPage.check("https://docs.example.com/denied.html", {
          ancestors: ["https://app.smithers.sh"]
        })
        expect(wpDenied.framing).toBe("refused")
        expect((yield* WebPage.check("http://127.0.0.1/x", { ancestors: ["https://app.smithers.sh"] })).reason)
          .toBe("private_host")
        expect((yield* WebPage.check("ftp://docs.example.com/x", { ancestors: ["https://app.smithers.sh"] })).reason)
          .toBe("invalid_url")
        expect(
          (yield* WebPage.check("https://docs.example.com/pdf", { ancestors: ["https://app.smithers.sh"] })).framing
        )
          .toBe("refused")
        expect(
          (yield* WebPage.check("https://docs.example.com/redirect-loop", { ancestors: ["https://app.smithers.sh"] }))
            .framing
        )
          .toBe("unknown")
        expect(
          (yield* WebPage.check("https://docs.example.com/404", { ancestors: ["https://app.smithers.sh"] })).framing
        )
          .toBe("unknown")
        expect(
          (yield* WebPage.check("https://docs.example.com/neterr", { ancestors: ["https://app.smithers.sh"] })).framing
        )
          .toBe("unknown")
      }).pipe(Effect.provide(Layer.merge(fetchLayer, silentLayer)))
    )
  })

  it("Presentation.make/guardHost/harden & PresentationRealm QuickJS sandbox render, reduce & block escapes", async () => {
    // 1. Presentation.make + guardHost + harden directly
    const Card = ({ children }: { readonly children?: React.ReactNode }) =>
      jsxRuntime.jsx("div", { className: "sui-card", children })
    const installed = Presentation.make({
      react: React,
      jsxRuntime,
      renderToStaticMarkup,
      components: { Card }
    })
    const html = installed.render(
      (require, _m, exports) => {
        exports.default = ({ props, state }: { props: { t: string }; state: { n: number } }) =>
          (require("react/jsx-runtime") as { jsx: (c: unknown, p: unknown) => unknown }).jsx(
            (require("@smthrs/ui") as { Card: unknown }).Card,
            { children: `${props.t}:${state.n}` }
          )
      },
      "{\"t\":\"Hi\"}",
      "{\"n\":3}"
    )
    expect(html).toBe("<div class=\"sui-card\">Hi:3</div>")
    expect(() => Presentation.guardHost("script", {})).toThrow()
    expect(Presentation.guardHost("div", { onClick: () => {}, id: "ok" })).toEqual({ id: "ok" })
    expect(() => Presentation.guardHost("div", { href: "https://evil.example" })).toThrow()
    expect(() => Presentation.guardHost("img", { src: "https://evil.example/a.png" })).toThrow()
    expect(Presentation.guardHost("img", { src: "data:image/png;base64,AA==" })).toEqual({
      src: "data:image/png;base64,AA=="
    })
    // Also test guardRenderer patching & failure on missing emitter
    const patched = Presentation.guardRenderer("function pushStartInstance(target, type, props, ctx) { return 1 }")
    expect(patched).toContain(Presentation.hostGuardName)
    expect(() => Presentation.guardRenderer("function other() {}")).toThrow()
    const obj = { nested: { a: 1 } }
    harden(obj)
    expect(Object.isFrozen(obj.nested)).toBe(true)

    // 2. PresentationRealm QuickJS sandbox render + reduce + escape refusal
    const mod = checked(
      [
        `export const interactions = { inc: { kind: "state" } } as const`,
        `export function reduce(state: { n: number }, event: { name: string }) { return { n: (state?.n ?? 0) + 1 } }`,
        `export default function View({ props, state }: { props: { label: string }; state: { n: number } }) {`,
        `  return <section><p>{props.label}:{state.n}</p><button data-action="inc">+</button></section>`,
        `}`
      ].join("\n")
    )

    await withRealm((realm) =>
      Effect.gen(function*() {
        const rendered = yield* realm.render({ module: mod, props: { label: "Count" }, state: { n: 2 } })
        expect(rendered).toContain("Count:2")

        const next = yield* realm.interact({
          module: mod,
          props: { label: "Count" },
          state: { n: 2 },
          event: { name: "inc" }
        })
        expect(next.state).toEqual({ n: 3 })
        expect(next.html).toContain("Count:3")

        // Unchecked malicious module attempting forbidden element is blocked inside QuickJS realm!
        const evilHtml = yield* Effect.result(
          realm.render({
            module: unchecked(
              `"use strict";var _j=require("react/jsx-runtime");exports.default=function(){return _j.jsx("script",{children:"alert(1)"})};`
            ),
            props: {},
            state: null
          })
        )
        expect(Result.isFailure(evilHtml)).toBe(true)

        // Throwing view returns typed RealmError
        const throwing = yield* Effect.result(
          realm.render({
            module: unchecked(`"use strict";exports.default=function(){throw new Error("boom")};`),
            props: {},
            state: null
          })
        )
        expect(Result.isFailure(throwing)).toBe(true)

        // Infinite loop hits gas/deadline limit cleanly
        const looping = yield* Effect.result(
          realm.render({
            module: unchecked(`"use strict";exports.default=function(){while(true){}};`),
            props: {},
            state: null
          })
        )
        expect(Result.isFailure(looping)).toBe(true)
      }), { limits: { renderMs: 150 } })
  })
})
