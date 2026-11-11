// worker/Body.ts: every bound `readBounded` holds, on real web requests.
import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import { readBounded } from "./Body.vibe"

const read = (init: RequestInit & { duplex?: "half" }, maxBytes = 8) => {
  let bytes = -1
  return Effect.runPromise(
    readBounded(
      HttpServerRequest.fromWeb(new Request("http://chat.test/", { method: "POST", ...init })),
      maxBytes,
      (n) => {
        bytes = n
      },
    ).pipe(Effect.result),
  ).then((result) => ({ result, bytes }))
}

describe("readBounded", () => {
  test("reads a body within the bound, multibyte characters split across chunks included, and reports its size", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x68, 0xc3]))
        controller.enqueue(new Uint8Array([0xa9]))
        controller.close()
      },
    })

    const { result, bytes } = await read({ body, duplex: "half" })

    expect(result).toMatchObject({ _tag: "Success", success: "hé" })
    expect(bytes).toBe(3)
  })

  test("refuses a declared length over the bound before reading", async () => {
    const { result, bytes } = await read({ body: "0123456789", headers: { "content-length": "10" } })

    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "too_large" } })
    expect(bytes).toBe(-1)
  })

  test("refuses a streamed body that passes the bound, malformed UTF-8, and a body that breaks off", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]))
        controller.error(new Error("connection reset"))
      },
    })

    expect((await read({ body: "0123456789" })).result).toMatchObject({ failure: { reason: "too_large" } })
    expect((await read({ body: new Uint8Array([0x61, 0xff]) })).result).toMatchObject({ failure: { reason: "utf8" } })
    expect((await read({ body: new Uint8Array([0x61, 0xc3]) })).result).toMatchObject({ failure: { reason: "utf8" } })
    expect((await read({ body: broken, duplex: "half" })).result).toMatchObject({ failure: { reason: "body" } })
  })

  test("reports nothing when no one listens for the size", async () => {
    const text = await Effect.runPromise(
      readBounded(HttpServerRequest.fromWeb(new Request("http://chat.test/", { method: "POST", body: "ok" })), 8),
    )

    expect(text).toBe("ok")
  })
})
