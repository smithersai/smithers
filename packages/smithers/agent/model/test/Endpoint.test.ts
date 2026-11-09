import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Endpoint from "../src/Endpoint.vibe"

const make = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const failureMessage = (options: Endpoint.MakeOptions): string => {
  const result = Endpoint.make(options)
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure.message : ""
}

describe("Endpoint", () => {
  it("validates and canonicalizes secure endpoints without changing public HTTP identities", () => {
    expect(Result.isFailure(Endpoint.makeSecure({ url: "not a url" }))).toBe(true)
    expect(Result.getOrThrow(Endpoint.makeSecure({ url: "https://provider.test/v1", query: { b: "2", a: "1" } })))
      .toEqual(make({ url: "https://provider.test/v1", query: { a: "1", b: "2" } }))
    expect(make({ url: "http://chat.test/api/model" }).url).toBe("http://chat.test/api/model")
  })

  it.each([
    "http://provider.test/v1",
    "http://192.168.1.2/v1",
    "http://localhost.evil.test/v1",
    "http://[::ffff:c000:201]/v1"
  ])(
    "rejects remote plaintext targets: %s",
    (url) => {
      const result = Endpoint.makeSecure({ url })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.message).toMatch(/https/i)
    }
  )

  it.each(["http://localhost:8080/v1", "http://127.0.0.1:8080/v1", "http://127.1.2.3/v1", "http://[::1]:8080/v1"])(
    "allows loopback development targets: %s",
    (url) => {
      expect(Result.getOrThrow(Endpoint.makeSecure({ url })).url).toBe(url)
    }
  )

  it("joins paths and renders sorted query pairs deterministically", () => {
    const endpoint = make({
      url: "https://example.test/v1/",
      path: "/responses",
      query: [["z", "last"], ["a", "two"], ["a", "one"]]
    })

    expect(endpoint).toEqual({
      method: "POST",
      url: "https://example.test/v1/responses",
      query: [["a", "one"], ["a", "two"], ["z", "last"]]
    })
    expect(Endpoint.render(endpoint)).toBe("https://example.test/v1/responses?a=one&a=two&z=last")
  })

  it("rejects embedded userinfo credentials", () => {
    expect(failureMessage({ url: "https://user:password@example.test" })).toMatch(/credentials/)
  })

  it("rejects every URL scheme except http and https", () => {
    for (const url of ["ftp://example.test/v1", "file:///etc/passwd", "data:text/plain,x"]) {
      expect(failureMessage({ url })).toBe("Endpoint URLs must use http or https")
    }
  })

  it("rejects relative path segments before the URL parser can collapse them", () => {
    expect(failureMessage({ url: "https://example.test/v1", path: "../../admin" })).toBe(
      "Endpoint paths must not contain relative segments"
    )
  })

  it("rejects percent-encoded relative path segments", () => {
    for (const path of ["%2e%2e/admin", ".%2e/admin", "%2E%2e/admin"]) {
      const result = Endpoint.make({ url: "https://provider.test/v1", path })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          code: "invalid_request",
          message: "Endpoint paths must not contain relative segments"
        })
      }
    }
  })

  it("rejects a joined path the URL parser rewrites outside its base", () => {
    const result = Endpoint.make({ url: "https://provider.test/v1", path: "..\\..\\admin" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.code).toBe("invalid_request")
  })

  it("keeps an ordinary nested path beneath its base", () => {
    expect(make({ url: "https://provider.test/v1", path: "chat/completions" }).url).toBe(
      "https://provider.test/v1/chat/completions"
    )
  })

  it("rejects credential-looking query parameters", () => {
    expect(failureMessage({ url: "https://example.test/?key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?api_key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["token", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["signature", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?password=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: { sig: "secret" } })).toMatch(/credentials/)
  })

  it("rejects an unparseable URL, a fragment, and a path carrying its own query", () => {
    expect(failureMessage({ url: "not a url" })).toBe("Endpoint URL could not be parsed")
    expect(failureMessage({ url: "" })).toBe("Endpoint URL could not be parsed")
    expect(failureMessage({ url: "https://example.test/#section" })).toMatch(/fragments/)
    expect(failureMessage({ url: "https://example.test", path: "/v1?debug=1" })).toMatch(
      /must not contain query strings or fragments/
    )
    expect(failureMessage({ url: "https://example.test", path: "/v1#frag" })).toMatch(
      /must not contain query strings or fragments/
    )
    expect(failureMessage({ url: "https://user@example.test" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://:password@example.test" })).toMatch(/credentials/)
  })

  it("does not echo a malformed URL carrying a credential-shaped value", () => {
    const credential = "sk-secret-token-value"
    const message = failureMessage({ url: `https://[${credential}` })
    expect(message).toBe("Endpoint URL could not be parsed")
    expect(message).not.toContain(credential)
  })

  it("allows public token-count query parameters", () => {
    const endpoint = make({ url: "https://example.test/v1", query: [["max_tokens", "8"]] })
    expect(Endpoint.render(endpoint)).toBe("https://example.test/v1?max_tokens=8")
  })

  it("accepts record query input and merges it with the URL's own pairs", () => {
    expect(make({ url: "https://example.test/?b=url", query: { a: "record" } })).toEqual({
      method: "POST",
      url: "https://example.test/",
      query: [["a", "record"], ["b", "url"]]
    })
  })

  it("orders equal names by value and keeps identical pairs stable", () => {
    const endpoint = make({
      url: "https://example.test",
      query: [["b", "2"], ["a", "9"], ["a", "1"], ["a", "9"], ["c", "3"]]
    })

    expect(endpoint.query).toEqual([["a", "1"], ["a", "9"], ["a", "9"], ["b", "2"], ["c", "3"]])
    expect(Endpoint.render(endpoint)).toBe("https://example.test/?a=1&a=9&a=9&b=2&c=3")
  })

  it("moves a larger value after a smaller value with the same name", () => {
    expect(make({ url: "https://example.test", query: [["a", "1"], ["a", "2"]] }).query).toEqual([
      ["a", "1"],
      ["a", "2"]
    ])
  })

  it("treats an absent, empty, and slash-heavy path the same way", () => {
    expect(make({ url: "https://example.test/v1" }).url).toBe("https://example.test/v1")
    expect(make({ url: "https://example.test/v1", path: "" }).url).toBe("https://example.test/v1")
    expect(make({ url: "https://example.test/v1//", path: "//responses" }).url).toBe(
      "https://example.test/v1/responses"
    )
  })

  it("renders an endpoint without query pairs and one whose values need escaping", () => {
    const bare = make({ url: "https://example.test/v1/responses" })
    expect(bare.query).toEqual([])
    expect(Endpoint.render(bare)).toBe("https://example.test/v1/responses")

    const escaped = make({ url: "https://example.test", query: [["q", "a b&c"]] })
    expect(Endpoint.render(escaped)).toBe("https://example.test/?q=a+b%26c")
  })
})
