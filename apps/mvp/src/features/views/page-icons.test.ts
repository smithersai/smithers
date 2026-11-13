import { WebPage } from "@smthrs/views"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { MAX_PAGE_BODY_BYTES } from "./contract"
import { PageProps, PageWrite } from "./schema"

describe("host-fetched page icons in saved views", () => {
  test("the producer schema's inline icon survives the page write contract", () => {
    const icon = "data:image/png;base64," + "Kioq".repeat(20_000)
    const checked = Schema.decodeUnknownSync(WebPage.Checked)({ framing: "refused", reason: "x_frame_options", icon })
    const write = { id: "78bc47fa-f393-4a22-94d3-eaf0aefbfb62", template: "link", props: { url: "https://example.com", icon: checked.icon } }
    expect(Schema.decodeUnknownSync(PageWrite)(write)).toEqual(write)
    expect(new TextEncoder().encode(JSON.stringify(write)).byteLength).toBeLessThan(MAX_PAGE_BODY_BYTES)
  })

  test("old HTTPS icon rows remain decodable", () => {
    const props = { url: "https://example.com", icon: "https://example.com/icon.png" }
    expect(Schema.decodeUnknownSync(PageProps)(props)).toEqual(props)
  })

  test.each([["HTML", "data:text/html,bad"], ["script", "javascript:bad()"], ["oversized", "data:image/png;base64," + "A".repeat(WebPage.MAX_ICON_DATA_URL)]])(
    "refuses unsafe or oversized icon %s",
    (_name, icon) => expect(Schema.is(PageProps)({ url: "https://example.com", icon })).toBe(false),
  )
})
