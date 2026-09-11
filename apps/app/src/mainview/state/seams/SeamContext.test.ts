import { describe, expect, test } from "bun:test"
import { readErrorMessage } from "./SeamContext"

/*
 * §28.5: no debug string is ever visible to a user. An upstream's raw body is
 * plumbing — a router's "404 page not found", an HTML error page, a stack
 * trace — and only a message the upstream addressed to a person (a JSON
 * `message` or `error` field) may reach the screen.
 */

const body = (text: string, contentType?: string): Response =>
  new Response(text, {
    status: 404,
    headers: contentType === undefined ? undefined : { "content-type": contentType }
  })

describe("readErrorMessage surfaces only what was written for a person", () => {
  test("a JSON message field is the message", async () => {
    expect(await readErrorMessage(body(JSON.stringify({ message: "no such key" })), "fallback")).toBe(
      "no such key"
    )
  })

  test("a JSON error field is the message when there is no message field", async () => {
    expect(await readErrorMessage(body(JSON.stringify({ error: "rate limited" })), "fallback")).toBe(
      "rate limited"
    )
  })

  test("a router's plain-text 404 never reaches the user", async () => {
    expect(await readErrorMessage(body("404 page not found"), "Your provider keys couldn't be listed right now.")).toBe(
      "Your provider keys couldn't be listed right now."
    )
  })

  test("an HTML error page never reaches the user", async () => {
    expect(
      await readErrorMessage(body("<!doctype html><title>502 Bad Gateway</title>", "text/html"), "fallback")
    ).toBe("fallback")
  })

  test("a JSON body with no message or error field falls back", async () => {
    expect(await readErrorMessage(body(JSON.stringify({ code: 17 })), "fallback")).toBe("fallback")
  })

  test("an empty body falls back", async () => {
    expect(await readErrorMessage(body(""), "fallback")).toBe("fallback")
  })

  test("a long message is bounded", async () => {
    const long = "x".repeat(1000)
    const message = await readErrorMessage(body(JSON.stringify({ message: long })), "fallback")
    expect(message.length).toBe(240)
  })
})
