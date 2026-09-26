import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Schema, Tracer } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { toMarkdown, toText } from "../src/internal/Html.ts"
import * as WebFetch from "../src/WebFetch.ts"

const responseLayer = (
  body: BodyInit,
  headers: Readonly<Record<string, string>>,
  status = 200
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status, headers }))
      )
    )
  )

describe("WebFetch", () => {
  it("declares bounded HTTP retrieval with all supported render formats", () => {
    expect(WebFetch.capabilities).toEqual(["net:get:*"])
    expect(toText("<h1>Article</h1><script>ignored()</script><p>Hello &amp; goodbye.</p>")).toBe(
      "Article\nHello & goodbye."
    )
    expect(toMarkdown("<h1>Article</h1><p>Hello <strong>world</strong>.</p>")).toBe("# Article\n\nHello **world**.")
  })

  it("describes every model-facing input and output field", () => {
    const input = Schema.toJsonSchemaDocument(WebFetch.Input).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }
    const output = Schema.toJsonSchemaDocument(WebFetch.Output).schema as {
      readonly properties: Readonly<Record<string, { readonly description?: string }>>
    }

    expect(Object.values(input.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
    expect(Object.values(output.properties).every((field) => JSON.stringify(field).includes("\"description\""))).toBe(
      true
    )
  })

  it("fetches a recorded HTML response through the kernel client", async () => {
    const html = readFileSync(new URL("./fixtures/webfetch/article.html", import.meta.url), "utf8")
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/article", format: "markdown" }).pipe(
        Effect.provide(responseLayer(html, { "content-type": "text/html" })),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    )
    expect(output).toMatchObject({
      url: "https://example.test/article",
      status: 200,
      contentType: "text/html",
      content: "# Article\n\nHello **world**."
    })
    expect(spans.some((span) => span.name === "WebFetch.run")).toBe(true)
  })

  it("leaves malformed and non-scalar numeric entities unchanged", async () => {
    const entities = "&#x110000; &#99999999999; &#55296; &#;"
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/entities", format: "text" }).pipe(
        Effect.provide(responseLayer(`<p>${entities}</p>`, { "content-type": "text/html" }))
      )
    )

    expect(output.content).toBe(entities)
  })

  it.each([
    ["empty", ""],
    ["malformed", "http://[::1"]
  ])("returns a typed failure for an %s redirect location", async (_kind, location) => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url: "https://example.test/redirect" }).pipe(
          Effect.provide(responseLayer("", { location }, 302))
        )
      )
    )

    expect(failure).toMatchObject({ code: "invalid_input", path: location })
  })

  it.each([
    ["file", "file:///etc/passwd"],
    ["data", "data:text/plain,hello"],
    ["ftp", "ftp://example.test/file"],
    ["protocol-relative", "//example.test/file"],
    ["malformed", "http://[::1"],
    ["userinfo", "https://user:pass@example.test/private"]
  ])("rejects %s URLs before dispatch", async (_kind, url) => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url }).pipe(Effect.provide(responseLayer("unexpected", { "content-type": "text/plain" })))
      )
    )

    expect(failure).toMatchObject({ code: "invalid_input", path: url })
  })

  it.each([
    ["http", "http://example.test/resource"],
    ["https", "https://example.test/resource"],
    ["IPv6", "http://[::1]/resource"]
  ])("fetches ordinary %s URLs", async (_kind, url) => {
    const output = await Effect.runPromise(
      WebFetch.run({ url }).pipe(Effect.provide(responseLayer("ok", { "content-type": "text/plain" })))
    )

    expect(output.content).toBe("ok")
  })

  it("keeps the 60 KB head of a 1 MiB response and discloses the cut", async () => {
    const body = "x".repeat(1024 * 1024)
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/big", format: "text" }).pipe(
        Effect.provide(responseLayer(body, { "content-type": "text/plain" }))
      )
    )

    expect(output.content).toBe("x".repeat(60_000))
    expect(output.truncated).toBe(true)
    expect(output.notice).toBe("Showing 60000 of 1048576 bytes; output was truncated.")
  })

  it("caps the rendered page, not the raw HTML", async () => {
    const html = `<script>${"x".repeat(70_000)}</script><p>Hello</p>`
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/scripted" }).pipe(
        Effect.provide(responseLayer(html, { "content-type": "text/html" }))
      )
    )

    expect(output).toMatchObject({ content: "Hello", truncated: false })
    expect(output).not.toHaveProperty("notice")
  })

  it("reports an untruncated body without a notice", async () => {
    const output = await Effect.runPromise(
      WebFetch.run({ url: "https://example.test/small" }).pipe(
        Effect.provide(responseLayer("ok", { "content-type": "text/plain" }))
      )
    )

    expect(output).toMatchObject({ content: "ok", truncated: false })
    expect(output).not.toHaveProperty("notice")
  })

  it("stops streaming once a response exceeds the byte cap", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        WebFetch.run({ url: "https://example.test/large" }).pipe(
          Effect.provide(responseLayer("x".repeat(5 * 1024 * 1024 + 1), { "content-type": "text/plain" }))
        )
      )
    )
    expect(failure).toMatchObject({
      code: "response_too_large"
    })
  })
})
