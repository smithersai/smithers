import { describe, expect, test } from "bun:test"
import { shortId } from "./ids"

/*
 * Review finding ui-cards-tabs/maintainability/4: this rule was copied into
 * ChangeCards, FileCards and WorkspaceCard and inlined twice in the composer.
 */
describe("an id renders short", () => {
  test("a jj change id is already a short word and renders whole", () => {
    expect(shortId("qupxosqw")).toBe("qupxosqw")
    expect(shortId("qupxosqwmnlk")).toBe("qupxosqwmnlk")
  })

  test("a commit hash takes the first 8", () => {
    expect(shortId("9f2c1ab4d7e0c3b5a6f8")).toBe("9f2c1ab4")
    expect(shortId("0123456789abc")).toBe("01234567")
  })

  test("an empty id stays empty rather than becoming a placeholder", () => {
    expect(shortId("")).toBe("")
  })
})
