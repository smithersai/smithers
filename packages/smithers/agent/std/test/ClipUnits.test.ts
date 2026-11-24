/**
 * A cut at a fixed UTF-16 index can leave half of a surrogate pair, which is
 * not well-formed Unicode: the canonical encoder refuses the string and the
 * tool result that carries it cannot be digested.
 */
import * as Credential from "@smthrs/control/Credential"
import * as HttpClient from "@smthrs/kernel/HttpClient"
import { Effect, Layer, Redacted } from "effect"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as ExaWebSearch from "../src/ExaWebSearch.ts"
import { clipUnits } from "../src/internal/Text.ts"
import * as WebSearch from "../src/WebSearch.ts"

describe("clipUnits", () => {
  it("returns a text within the bound unchanged", () => {
    expect(clipUnits("", 4)).toBe("")
    expect(clipUnits("abcd", 4)).toBe("abcd")
    expect(clipUnits("ab😀", 4)).toBe("ab😀")
  })

  it("cuts at the bound when the cut falls between characters", () => {
    expect(clipUnits("abcdef", 4)).toBe("abcd")
    expect(clipUnits("ab😀ef", 4)).toBe("ab😀")
  })

  it("cuts one unit earlier rather than split a surrogate pair", () => {
    const clipped = clipUnits("abc😀def", 4)
    expect(clipped).toBe("abc")
    expect(clipped.isWellFormed()).toBe(true)
  })
})

describe("an Exa snippet", () => {
  const search = (text: string) => {
    const reference = { id: "test-exa", name: "Test Exa" }
    const credential = Credential.Credential.of({
      ...Credential.makeNoop(),
      get: () => Effect.succeed(reference),
      resolve: () => Effect.succeed(Redacted.make("dummy-private-key"))
    })
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ results: [{ url: "https://example.invalid/a", text }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      ))
    )
    return Effect.runPromise(
      WebSearch.run({ query: "widgets" }).pipe(
        Effect.provide(
          ExaWebSearch.layer("test-exa").pipe(Layer.provide(Layer.merge(
            Layer.succeed(Credential.Credential, credential),
            Layer.succeed(HttpClient.HttpClient, http)
          )))
        )
      )
    )
  }

  it("is well-formed when an emoji straddles the 2,000-unit cut", async () => {
    const result = await search("x".repeat(1999) + "😀" + "tail")
    const snippet = result.results[0]!.snippet
    expect(snippet).toBe("x".repeat(1999))
    expect(snippet.isWellFormed()).toBe(true)
  })

  it("keeps 2,000 units when the cut falls between characters", async () => {
    const result = await search("x".repeat(1998) + "😀" + "tail")
    expect(result.results[0]!.snippet).toBe("x".repeat(1998) + "😀")
  })
})
