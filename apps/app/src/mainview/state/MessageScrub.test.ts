import { describe, expect, test } from "bun:test"
import { scrubToolEcho } from "./MessageScrub"

describe("the tool-echo scrub", () => {
  const preservedMessages = [
    ["nested fenced indentation", "```python\nif ready:\n    for item in items:\n        print(item)\n```"],
    ["indented Markdown code", "Example:\n\n    print('a  b')\n        nested()\n"],
    ["inline literal spaces", "Keep `a  b` and ``a ` b  c`` literal."],
    ["tabs and blank lines", "\n\n\tif ready:\n\t\tgo()\n\n\nDone.  \n"],
    ["ordinary prose whitespace", "  First  sentence.\n\n\nSecond sentence.  \n"],
    ["non-tool JSON", "  {\"action\":\"explain\",\"value\":\"a  b\"}  \n"],
    ["unbalanced JSON", "  {\"action\":\"execute\",\"value\":\"a  b\"  \n"]
  ] as const

  for (const [name, text] of preservedMessages) {
    test(`preserves ${name} byte-for-byte without echoes`, () => {
      expect(scrubToolEcho(text)).toBe(text)
    })

    test(`preserves ${name} away from a removed echo`, () => {
      expect(scrubToolEcho(`{\"action\":\"list\"}\n${text}`)).toBe(`\n${text}`)
    })
  }

  test("preserves seam whitespace in messages containing code", () => {
    for (const text of [
      "`a {\"action\":\"list\"} b`",
      "```\na {\"action\":\"list\"} b\n```",
      "~~~\na {\"action\":\"list\"} b\n~~~",
      "    a {\"action\":\"list\"} b",
      ">     a {\"action\":\"list\"} b"
    ]) {
      expect(scrubToolEcho(text)).toBe(text.replace('{"action":"list"}', ""))
    }
  })

  test("cleans only the single separator space at a prose seam", () => {
    expect(scrubToolEcho('  Before  this {"action":"list"} after  that.  \n'))
      .toBe("  Before  this after  that.  \n")
    expect(scrubToolEcho('done {"action":"list"}')).toBe("done")
    expect(scrubToolEcho('{"action":"list"}')).toBe("")
  })

  test("strips an inline execute blob and keeps the prose around it", () => {
    expect(
      scrubToolEcho(
        "Let me check.{\"action\":\"execute\",\"name\":\"flow.list\",\"args\":\"\"}Here is the list."
      )
    ).toBe("Let me check.Here is the list.")
  })

  test("strips list blobs and multiple blobs", () => {
    expect(
      scrubToolEcho("{\"action\":\"list\"} and then {\"action\":\"execute\",\"name\":\"world\"} done")
    ).toBe("and then done")
  })

  test("handles nested braces and escaped quotes inside args", () => {
    expect(
      scrubToolEcho("ok {\"action\":\"execute\",\"name\":\"send\",\"args\":\"{\\\"a\\\":1} and \\\"b\\\"\"} fine")
    ).toBe("ok fine")
  })

  test("leaves ordinary JSON prose alone", () => {
    const text = "The config is {\"retries\": 3} — set it in settings."
    expect(scrubToolEcho(text)).toBe(text)
  })

  test("leaves unbalanced text alone", () => {
    const text = "It starts with {\"action\":\"execute\" and never closes"
    expect(scrubToolEcho(text)).toBe(text)
  })
})
