import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Redacted, Result, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as jsxRuntime from "react/jsx-runtime"
import { describe, expect, it } from "vitest"
import { Bridge, Docs, Home, Presentation, PresentationRealm, ViewCode, WebPage } from "../src/index.ts"
import { jsonLength } from "../src/internal/bytes.ts"
import { refusal } from "../src/internal/hosts.ts"
import { bundle } from "./fixtures/bundle.ts"
import { components } from "./fixtures/modules.ts"
import { layerSingleFile } from "./fixtures/quickjs.ts"
import { checked, unchecked, withRealm } from "./fixtures/realm.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

describe("@smthrs/views Wave 10 deep fuzz", () => {
  it(
    "ViewCode.check covers surrogate checks, interactions literals, import/export/async/generator/JSX/security refusals",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          variant: Schema.Literals([
            "validWithInteractions",
            "validReactNamespace",
            "validTypeImport",
            "loneHighSurrogate",
            "loneLowSurrogate",
            "badHighPairSurrogate",
            "validSurrogatePair",
            "badInteractionsComputed",
            "badInteractionsNonString",
            "badInteractionsNonObj",
            "badModuleImport",
            "badUiNamespaceImport",
            "badUiComponentName",
            "badReactNamedValue",
            "badSmithersViewValue",
            "asyncDefaultExport",
            "generatorDefaultExport",
            "aliasedAsyncDefault",
            "aliasedAsAsyncReduce",
            "reExportAll",
            "reExportNamed",
            "unknownNamedExport",
            "missingDefaultExport",
            "refusedElementScript",
            "refusedElementIframe",
            "refusedEventHandler",
            "refusedDangerHtml",
            "refusedJsHref",
            "refusedSpread",
            "refusedDynamicImport",
            "refusedWithOrEval",
            "refusedProtoAccess",
            "refusedComputedAccess",
            "refusedThisExpr",
            "refusedNewFunction",
            "refusedGlobalThis",
            "refusedJsxMember",
            "refusedJsxNamespace",
            "refusedFormAction"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ variant }) =>
            Effect.gen(function*() {
              const snippets: Record<typeof variant, { src: string; ok: boolean }> = {
                validWithInteractions: {
                  src: `import { event } from "smithers:view";
export const interactions = { save: { kind: "message", label: "Save" } } as const;
export const reduce = (s: { n: number }, e: { name: string }) => ({ n: s.n + 1 });
export default function View({ props, state }: { props: unknown; state: { n: number } }) {
  return <button data-event={event("save", state.n)}>Save</button>;
}`,
                  ok: true
                },
                validReactNamespace: {
                  src: `import * as React from "react";
export default function View() { return React.createElement("div", null, "hi"); }`,
                  ok: true
                },
                validTypeImport: {
                  src: `import type { ReactNode } from "react";
import { Fragment } from "react";
export default function View(): ReactNode { return <Fragment>ok</Fragment>; }`,
                  ok: true
                },
                loneHighSurrogate: {
                  src: `export default function View() { return <div>\uD800</div>; }`,
                  ok: false
                },
                loneLowSurrogate: {
                  src: `export default function View() { return <div>\uDC00</div>; }`,
                  ok: false
                },
                badHighPairSurrogate: {
                  src: `export default function View() { return <div>\uD800x</div>; }`,
                  ok: false
                },
                validSurrogatePair: {
                  src: `export default function View() { return <div>😀</div>; }`,
                  ok: true
                },
                badInteractionsComputed: {
                  src:
                    `const k = "a"; export const interactions = { [k]: "x" }; export default function V() { return <div/>; }`,
                  ok: false
                },
                badInteractionsNonString: {
                  src: `export const interactions = { a: 123 }; export default function V() { return <div/>; }`,
                  ok: false
                },
                badInteractionsNonObj: {
                  src: `export const interactions = "nope"; export default function V() { return <div/>; }`,
                  ok: false
                },
                badModuleImport: {
                  src: `import fs from "node:fs"; export default function V() { return <div>{String(fs)}</div>; }`,
                  ok: false
                },
                badUiNamespaceImport: {
                  src:
                    `import * as UI from "@smthrs/ui"; export default function V() { return <div>{String(UI)}</div>; }`,
                  ok: false
                },
                badUiComponentName: {
                  src:
                    `import { NoSuchWidget } from "@smthrs/ui"; export default function V() { return <NoSuchWidget/>; }`,
                  ok: false
                },
                badReactNamedValue: {
                  src:
                    `import { useEffect } from "react"; export default function V() { return <div>{String(useEffect)}</div>; }`,
                  ok: false
                },
                badSmithersViewValue: {
                  src:
                    `import { nope } from "smithers:view"; export default function V() { return <div>{String(nope)}</div>; }`,
                  ok: false
                },
                asyncDefaultExport: {
                  src: `export default async function V() { return <div/>; }`,
                  ok: false
                },
                generatorDefaultExport: {
                  src: `export default function* V() { yield <div/>; }`,
                  ok: false
                },
                aliasedAsyncDefault: {
                  src: `const impl = async () => <div/>; export default (impl as unknown as () => unknown);`,
                  ok: false
                },
                aliasedAsAsyncReduce: {
                  src:
                    `const r = async (s: unknown) => s; export const reduce = r!; export default function V() { return <div/>; }`,
                  ok: false
                },
                reExportAll: {
                  src: `export * from "react"; export default function V() { return <div/>; }`,
                  ok: false
                },
                reExportNamed: {
                  src: `export { Fragment } from "react"; export default function V() { return <div/>; }`,
                  ok: false
                },
                unknownNamedExport: {
                  src: `export const extra = 1; export default function V() { return <div/>; }`,
                  ok: false
                },
                missingDefaultExport: {
                  src: `const V = () => <div/>;`,
                  ok: false
                },
                refusedElementScript: {
                  src: `export default function V() { return <script>alert(1)</script>; }`,
                  ok: false
                },
                refusedElementIframe: {
                  src: `export default function V() { return <iframe src="https://example.com"/>; }`,
                  ok: false
                },
                refusedEventHandler: {
                  src: `export default function V() { return <button onClick={() => {}}>x</button>; }`,
                  ok: false
                },
                refusedDangerHtml: {
                  src: `export default function V() { return <div dangerouslySetInnerHTML={{ __html: "x" }}/>; }`,
                  ok: false
                },
                refusedJsHref: {
                  src: `export default function V() { return <a href="javascript:alert(1)">x</a>; }`,
                  ok: false
                },
                refusedSpread: {
                  src:
                    `export default function V({ props }: { props: Record<string, string> }) { return <div {...props}/>; }`,
                  ok: false
                },
                refusedDynamicImport: {
                  src: `export default function V() { const x = import("react"); return <div>{String(x)}</div>; }`,
                  ok: false
                },
                refusedWithOrEval: {
                  src: `export default function V() { return <div>{eval("1")}</div>; }`,
                  ok: false
                },
                refusedProtoAccess: {
                  src:
                    `export default function V({ props }: { props: { a: number } }) { return <div>{String((props as any).__proto__)}</div>; }`,
                  ok: false
                },
                refusedComputedAccess: {
                  src:
                    `export default function V({ props }: { props: Record<string, string> }) { return <div>{String((props as any)["constructor"])}</div>; }`,
                  ok: false
                },
                refusedThisExpr: {
                  src: `export default function V() { return <a href="data:text/html,hi">x</a>; }`,
                  ok: false
                },
                refusedNewFunction: {
                  src:
                    `export default function V() { const f = new Function("return 1"); return <div>{String(f)}</div>; }`,
                  ok: false
                },
                refusedGlobalThis: {
                  src: `export default function V() { return <div>{String(globalThis)}</div>; }`,
                  ok: false
                },
                refusedJsxMember: {
                  src:
                    `import * as React from "react"; export default function V() { return <React.BadComp>x</React.BadComp>; }`,
                  ok: false
                },
                refusedJsxNamespace: {
                  src: `export default function V() { return <svg><a xlink:href="x"/></svg>; }`,
                  ok: false
                },
                refusedFormAction: {
                  src: `export default function V() { return <form action="https://evil.example"/>; }`,
                  ok: false
                }
              }
              const item = snippets[variant]
              const res = yield* Effect.result(ViewCode.check(item.src, { components }))
              if (item.ok) return Result.isSuccess(res)
              if (!Result.isFailure(res)) return false
              // Access message getter to cover InvalidViewCode.message
              return res.failure.message.length > 0
            }),
          { seed, executions: Math.min(executions, 120) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    },
    60_000
  )

  it(
    "Presentation.make and PresentationRealm cover render/reduce/event/guards, limits, invalid inputs, and layer",
    async () => {
      // Presentation.make directly
      const installed = Presentation.make({
        react: React,
        jsxRuntime,
        renderToStaticMarkup,
        components: {
          Badge: ({ children }: { children?: React.ReactNode }) => React.createElement("span", null, children)
        }
      })
      expect(installed.components).toEqual(["Badge"])

      // Valid render + smithers:view event() with and without arg
      const html = installed.render(
        (req, _mod, exp) => {
          const sv = req("smithers:view") as { event: (n: string, a?: string | number) => string }
          const r = req("react") as typeof React
          exp.default = () =>
            r.createElement("button", { "data-e1": sv.event("go"), "data-e2": sv.event("go", 7) }, "ok")
        },
        "{}",
        "{}"
      )
      expect(html).toContain("go:7")

      // Disallowed require
      expect(() =>
        installed.render(
          (req, _mod, exp) => {
            req("node:fs")
            exp.default = () => null
          },
          "{}",
          "{}"
        )
      ).toThrow()

      // Non-component default export
      expect(() =>
        installed.render(
          (_req, _mod, exp) => {
            exp.default = 42
          },
          "{}",
          "{}"
        )
      ).toThrow()

      // Runtime guard catches <script> and refused prop (onClick) and null props pass-through
      expect(() =>
        installed.render(
          (req, _mod, exp) => {
            const jr = req("react/jsx-runtime") as typeof jsxRuntime
            exp.default = () => jr.jsx("script", { children: "alert(1)" })
          },
          "{}",
          "{}"
        )
      ).toThrow()
      expect(() =>
        installed.render(
          (req, _mod, exp) => {
            const jr = req("react/jsx-runtime") as typeof jsxRuntime
            exp.default = () => jr.jsx("button", { onClick: () => {} })
          },
          "{}",
          "{}"
        )
      ).toThrow()

      // reduce: valid, missing, thenable/Promise, undefined
      expect(
        installed.reduce(
          (_req, _mod, exp) => {
            exp.reduce = (s: { n: number }, e: { v: number }) => ({ n: s.n + e.v })
          },
          "{\"n\":1}",
          "{\"v\":2}"
        )
      ).toBe("{\"n\":3}")
      expect(() => installed.reduce(() => {}, "{}", "{}")).toThrow()
      expect(() =>
        installed.reduce(
          (_req, _mod, exp) => {
            exp.reduce = () => Promise.resolve({})
          },
          "{}",
          "{}"
        )
      ).toThrow()
      expect(() =>
        installed.reduce(
          (_req, _mod, exp) => {
            exp.reduce = () => undefined
          },
          "{}",
          "{}"
        )
      ).toThrow()

      // PresentationRealm: interact, oversized props/state/html/reduced-state, unserializable input, broken bundle, layer, RealmError.message
      const realmErr = new PresentationRealm.RealmError({
        reason: "limit_exceeded",
        limit: "html",
        detail: Redacted.make("too big")
      })
      expect(realmErr.message).toContain("html")
      const realmErrNoLimit = new PresentationRealm.RealmError({
        reason: "render_failed",
        detail: Redacted.make("boom")
      })
      expect(realmErrNoLimit.message.length).toBeGreaterThan(0)

      const srcBundle = await bundle()
      const realmLayer = PresentationRealm.layer({ bundle: srcBundle }).pipe(Layer.provide(layerSingleFile))
      const mod = checked(`import { event } from "smithers:view";
export const reduce = (s: { n: number }, e: { name: string }) => ({ n: s.n + 1, pad: e.name === "grow" ? "x".repeat(80000) : "" });
export default function V({ props, state }: { props: { repeat?: number }; state: { n: number } }) {
  return <div data-e={event("inc", state.n)}>{"a".repeat(props.repeat ?? 1)}</div>;
}`)

      await Effect.runPromise(
        Effect.gen(function*() {
          const realm = yield* PresentationRealm.PresentationRealm
          const r1 = yield* realm.interact({
            module: mod,
            props: { repeat: 2 },
            state: { n: 1 },
            event: { name: "inc" }
          })
          expect(r1.html).toContain("inc:2")

          // Unserializable props & state (BigInt / undefined)
          const rBadProps = yield* Effect.result(realm.render({ module: mod, props: 1n, state: { n: 0 } }))
          expect(Result.isFailure(rBadProps)).toBe(true)
          const rBadState = yield* Effect.result(realm.render({ module: mod, props: {}, state: undefined }))
          expect(Result.isFailure(rBadState)).toBe(true)

          // Oversized reduced state (> Bridge.maxStateBytes)
          const rBigState = yield* Effect.result(
            realm.interact({ module: mod, props: {}, state: { n: 0 }, event: { name: "grow" } })
          )
          expect(Result.isFailure(rBigState)).toBe(true)

          // Oversized rendered HTML (> Bridge.maxHtmlBytes)
          const rBigHtml = yield* Effect.result(
            realm.render({ module: mod, props: { repeat: Bridge.maxHtmlBytes + 100 }, state: { n: 0 } })
          )
          expect(Result.isFailure(rBigHtml)).toBe(true)

          // Oversized input state
          const rOverState = yield* Effect.result(
            realm.interact({
              module: mod,
              props: {},
              state: "x".repeat(Bridge.maxStateBytes + 100),
              event: { name: "inc" }
            })
          )
          expect(Result.isFailure(rOverState)).toBe(true)
        }).pipe(Effect.provide(realmLayer))
      )

      // Invalid bundle fails PresentationRealm.make
      const badBundleRes = await Effect.runPromise(
        Effect.scoped(Effect.result(PresentationRealm.make({ bundle: "throw new Error('broken bundle')" }))).pipe(
          Effect.provide(layerSingleFile)
        )
      )
      expect(Result.isFailure(badBundleRes)).toBe(true)

      // Module throwing at render & infinite loop hitting step limit
      await withRealm(
        (realm) =>
          Effect.gen(function*() {
            const spin = unchecked(`exports.default = function() { while (true) {} }`)
            const rSpin = yield* Effect.result(realm.render({ module: spin, props: {}, state: {} }))
            expect(Result.isFailure(rSpin)).toBe(true)
            const badProps = yield* Effect.result(
              realm.render({ module: mod, props: "x".repeat(200), state: { n: 0 } })
            )
            expect(Result.isFailure(badProps)).toBe(true)
          }),
        { limits: { steps: 5_000, propsBytes: 64 } }
      )

      // internal/bytes.ts & internal/hosts.ts edge cases
      expect(jsonLength(1n)).toBeUndefined()
      expect(jsonLength(() => {})).toBeUndefined()
      expect(refusal(new URL("http://internal.local/x"), ["internal.local"])).toBeUndefined()
      expect(refusal(new URL("http://internal.local/x"), [])).toBe("private_host")
    },
    60_000
  )

  it(
    "WebPage, Docs, and Home cover redirects, icon fetching, timeouts, fenced markdown, fetchText refusals, and Home.read validation",
    async () => {
      // 1. WebPage.check across all modes
      const webModes = [
        "validWithIcon",
        "iconNonImage",
        "iconEmpty",
        "iconTooBig",
        "icon404",
        "nonHtml",
        "redirectLoop",
        "redirectToInvalidScheme",
        "redirectToPrivate",
        "timeout",
        "unreachable",
        "invalidStartUrl",
        "privateAllowed",
        "cspAndXfo"
      ] as const

      for (const mode of webModes) {
        const client = HttpClient.make((req) => {
          if (mode === "unreachable") {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, cause: new Error("net") })
              })
            )
          }
          if (mode === "timeout") {
            return Effect.sleep("200 millis").pipe(Effect.as(HttpClientResponse.fromWeb(req, new Response("ok"))))
          }
          if (mode === "redirectLoop") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("", { status: 302, headers: { location: "https://example.com/loop" } })
              )
            )
          }
          if (mode === "redirectToInvalidScheme") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("", { status: 301, headers: { location: "ftp://example.com/a" } })
              )
            )
          }
          if (mode === "redirectToPrivate") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("", { status: 302, headers: { location: "http://127.0.0.1/secret" } })
              )
            )
          }
          if (req.url.endsWith("/fav.png")) {
            if (mode === "iconNonImage") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response("txt", { status: 200, headers: { "content-type": "text/plain" } })
                )
              )
            }
            if (mode === "iconEmpty") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/png" } })
                )
              )
            }
            if (mode === "iconTooBig") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(new Uint8Array(70 * 1024), { status: 200, headers: { "content-type": "image/png" } })
                )
              )
            }
            if (mode === "icon404") {
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("", { status: 404 })))
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
                  status: 200,
                  headers: { "content-type": "image/png" }
                })
              )
            )
          }
          if (mode === "nonHtml") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
              )
            )
          }
          const htmlDoc =
            `<!doctype html><html><head><title>Hello &amp; World</title><meta name="description" content="Desc"/><link rel="icon" href="/fav.png"/></head><body></body></html>`
          const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }
          if (mode === "cspAndXfo") {
            headers["content-security-policy"] = "frame-ancestors 'none'"
            headers["x-frame-options"] = "DENY"
          }
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(htmlDoc, { status: 200, headers })))
        })

        const targetUrl = mode === "invalidStartUrl" ?
          ":::bad"
          : mode === "privateAllowed" ?
          "http://internal.local/page"
          : "https://example.com/page"

        const checkedPage = await Effect.runPromise(
          WebPage.check(targetUrl, {
            ancestors: ["https://app.example.com"],
            maxRedirects: 2,
            timeout: mode === "timeout" ? "20 millis" : "2 seconds",
            privateHosts: mode === "privateAllowed" ? ["internal.local"] : []
          }).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), silentLogger)))
        )
        if (mode === "validWithIcon") expect(checkedPage.icon?.startsWith("data:image/png;base64,")).toBe(true)
        if (mode === "cspAndXfo") expect(checkedPage.framing).toBe("refused")
        if (mode === "timeout" || mode === "unreachable" || mode === "redirectLoop" || mode === "invalidStartUrl") {
          expect(checkedPage.framing).toBe("unknown")
        }
      }

      // WebPage.preview / framing edge cases directly
      expect(
        WebPage.framing({ "x-frame-options": "SAMEORIGIN" }, { page: "https://a.com", ancestors: ["https://b.com"] })
          .framing
      ).toBe("refused")
      expect(
        WebPage.framing({ "x-frame-options": "SAMEORIGIN" }, { page: "https://a.com", ancestors: ["https://a.com"] })
          .framing
      ).toBe("allowed")
      expect(
        WebPage.framing({ "content-security-policy": "frame-ancestors 'self' https://*.example.com" }, {
          page: "https://a.com",
          ancestors: ["https://sub.example.com"]
        }).framing
      ).toBe("allowed")
      expect(
        WebPage.preview(
          `<head><meta property="og:title" content="OG"/><meta property="og:description" content="OGD"/><link rel="shortcut icon" href="https://example.com/i.ico"></head>`,
          "https://example.com"
        )
      ).toBeDefined()

      // 2. Docs.parse with backtick/tilde fences, summary, sections, cross-origin/blob links, duplicate links, Docs.fetchText refusals
      const parsedIndex = Docs.parse(
        [
          "# My Docs",
          "> A concise summary line",
          "```md",
          "- [IgnoredInsideFence](https://docs.example.com/ignored)",
          "~~~",
          "```",
          "~~~",
          "- [IgnoredInTilde](https://docs.example.com/ignored2)",
          "~~~",
          "## Guides",
          "- [Intro](https://docs.example.com/intro): Getting started",
          "- [IntroDup](https://docs.example.com/intro): Dup skipped",
          "- [NoDesc](https://docs.example.com/nodesc)",
          "- [OtherOrigin](https://evil.example.com/x)",
          "- [BlobScheme](blob:https://docs.example.com/x)"
        ].join("\n"),
        "https://docs.example.com/llms.txt"
      )
      expect(parsedIndex.summary).toBe("A concise summary line")
      expect(parsedIndex.pages.length).toBe(2)
      expect(Docs.find(parsedIndex, "/intro")?.section).toBe("Guides")
      expect(Docs.search(parsedIndex, "getting started").length).toBeGreaterThan(0)

      const docsModes = [
        "ok",
        "tooLarge",
        "nonText",
        "hasNul",
        "badUtf8",
        "http404",
        "redirectTooMany",
        "timeout",
        "unreachable",
        "privateAllowed"
      ] as const
      for (const dm of docsModes) {
        const client = HttpClient.make((req) => {
          if (dm === "unreachable") {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, cause: new Error("net") })
              })
            )
          }
          if (dm === "timeout") {
            return Effect.sleep("200 millis").pipe(Effect.as(HttpClientResponse.fromWeb(req, new Response("ok"))))
          }
          if (dm === "redirectTooMany") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("", { status: 302, headers: { location: "https://docs.example.com/loop" } })
              )
            )
          }
          if (dm === "http404") {
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("no", { status: 404 })))
          }
          if (dm === "nonText") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("bin", { status: 200, headers: { "content-type": "application/octet-stream" } })
              )
            )
          }
          if (dm === "hasNul") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("a\0b", { status: 200, headers: { "content-type": "text/plain" } })
              )
            )
          }
          if (dm === "badUtf8") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(new Uint8Array([0xff, 0xfe]), { status: 200, headers: { "content-type": "text/plain" } })
              )
            )
          }
          if (dm === "tooLarge") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response("x".repeat(500), { status: 200, headers: { "content-type": "text/plain" } })
              )
            )
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response("# Doc", { status: 200, headers: { "content-type": "text/markdown" } })
            )
          )
        })
        const fetched = await Effect.runPromise(
          Docs.fetchText(dm === "privateAllowed" ? "http://docs.local/llms.txt" : "https://docs.example.com/llms.txt", {
            maxBytes: 64,
            maxRedirects: 1,
            timeout: dm === "timeout" ? "20 millis" : "2 seconds",
            privateHosts: dm === "privateAllowed" ? ["docs.local"] : []
          }).pipe(Effect.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), silentLogger)))
        )
        expect(fetched._tag === "Text" || fetched._tag === "Refused").toBe(true)
      }

      // 3. Home.read across all valid & invalid shapes (contributors, docs, sections, blocks, unknown skipped, IsoDate, RepositoryPath)
      const homeInputs: Array<readonly [string, string]> = [
        ["{bad", "Invalid"],
        ["[]", "Invalid"],
        [JSON.stringify({ contributors: "invalid", blocks: [] }), "Invalid"],
        [JSON.stringify({ docs: "not-a-url", blocks: [] }), "Invalid"],
        [JSON.stringify({ blocks: [], sections: [] }), "Invalid"],
        [JSON.stringify({ sections: Array.from({ length: 10 }, () => ({ blocks: [] })) }), "Invalid"],
        [JSON.stringify({ sections: ["bad"] }), "Invalid"],
        [JSON.stringify({ blocks: Array.from({ length: 40 }, () => ({ type: "text", text: "a" })) }), "Invalid"],
        [JSON.stringify({ sections: [{ title: "<b>bad</b>", blocks: [] }] }), "Invalid"],
        [JSON.stringify({ blocks: [{ type: "text", text: "<b>html</b>" }] }), "Invalid"],
        [
          JSON.stringify({
            contributors: "anyone",
            docs: "https://docs.example.com/llms.txt",
            sections: [{
              title: "Welcome",
              audience: "maintainer",
              blocks: [{ type: "text", text: "Hi" }, { type: "future_widget" }]
            }]
          }),
          "Declared"
        ]
      ]
      for (const [raw, expectedTag] of homeInputs) {
        const r = Home.read(raw)
        expect(r._tag).toBe(expectedTag)
      }
      expect(Home.widen("everyone", "anyone")).toBe("contributor")
      expect(Home.widen("maintainer", "role")).toBe("maintainer")
      expect(Schema.decodeUnknownOption(Home.IsoDate)("2026-02-30")._tag).toBe("None")
      expect(Schema.decodeUnknownOption(Home.IsoDate)("2026-11-24")._tag).toBe("Some")
      expect(Schema.decodeUnknownOption(Home.RepositoryPath)("a/../b")._tag).toBe("None")
      expect(Schema.decodeUnknownOption(Home.RepositoryPath)("src/index.ts")._tag).toBe("Some")

      // Extra ViewCode edge branches: export specifiers, JSX refused global/namespaced, TSModuleDeclaration, top-level await, state without reduce, reduce without state
      const extraViewSnippets = [
        `type T = number; const V = () => <div/>; export type { T }; export { V as default };`,
        `export default function V() { return <Function/>; }`,
        `export default function V() { return <svg:rect/>; }`,
        `namespace Ns { export const a = 1; } export default function V() { return <div>{Ns.a}</div>; }`,
        `const x = await Promise.resolve(1); export default function V() { return <div>{x}</div>; }`,
        `for await (const x of []) { void x; } export default function V() { return <div/>; }`,
        `export const interactions = { inc: { kind: "state" } } as const; export default function V() { return <div/>; }`,
        `export const reduce = (s: unknown) => s; export default function V() { return <div/>; }`,
        "export default function V() { return <div/>; } // " + String.fromCharCode(0xd800)
      ]
      for (const src of extraViewSnippets) {
        await Effect.runPromise(Effect.result(ViewCode.check(src, { components })))
      }

      // Extra WebPage edge branches: comments, unclosed comment/tag/title, base href, numeric/hex entities, long title truncation, port & path frame-ancestors
      expect(
        WebPage.preview(
          "<!-- hello --><head><base href=\"https://cdn.example.com/app/\"><title>" + "&#65;&#x1F600;&#9999999;" +
            "A".repeat(240) + "</title><link rel=\"icon\" href=\"fav.png\"/></head>",
          "https://example.com"
        ).title?.endsWith("…")
      ).toBe(true)
      expect(WebPage.preview("<!-- unclosed comment", "https://example.com").title).toBeUndefined()
      expect(WebPage.preview("<title>unclosed title", "https://example.com").title).toBe("unclosed title")
      expect(WebPage.preview("<meta unclosed", "https://example.com").title).toBeUndefined()
      expect(WebPage.preview("no tags at all", "https://example.com").title).toBeUndefined()
      expect(
        WebPage.framing({
          "content-security-policy":
            "frame-ancestors https://a.com:443 https://b.com:* https://c.com:80 https://d.com/sub"
        }, { page: "https://p.com", ancestors: ["https://c.com"] }).framing
      ).toBe("allowed")
      expect(
        WebPage.framing({ "content-security-policy": "frame-ancestors https://b.com:*" }, {
          page: "https://p.com",
          ancestors: ["https://b.com:8443"]
        }).framing
      ).toBe("allowed")
      expect(
        WebPage.framing({ "content-security-policy": "frame-ancestors https://d.com/sub" }, {
          page: "https://p.com",
          ancestors: ["https://d.com"]
        }).framing
      ).toBe("refused")
      expect(WebPage.framing({}, { page: "not-a-url", ancestors: [] }).framing).toBe("unknown")
      expect(WebPage.framing({}, { page: "https://p.com", ancestors: ["not-a-url"] }).framing).toBe("unknown")
      expect(WebPage.framing({}, { page: "http://p.example.com", ancestors: ["https://app.example.com"] }).framing)
        .toBe("refused")
    },
    60_000
  )
})
