import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import * as Y from "yjs"
import {
  decodeWikiState,
  editWikiState,
  encodeWikiState,
  makeCloudWikiTransport,
  mergeWikiState,
  wikiPagePath,
  wikiStateContains
} from "./CloudWiki"

import nativeDeletion from "./fixtures/yrs-deletion-ack.json"

const stateOf = (text: string) => {
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, text)
  const state = encodeWikiState(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return state
}

describe("Plue Wiki Yjs-v1 contract", () => {
  test("independent edits merge without duplicating the causal seed, including Unicode boundaries", () => {
    const initial = stateOf("# Page\n\nA 🌱 tree.")
    const left = editWikiState(initial, "# Page\n\nA 🌳 tree.", 101)
    const right = editWikiState(initial, "# Page\n\nA 🌱 tree.\n\nNext", 102)
    expect(mergeWikiState(initial, left.update, right.update).body).toBe("# Page\n\nA 🌳 tree.\n\nNext")
    expect(mergeWikiState(initial, right.update, left.update, left.update)).toEqual(
      mergeWikiState(initial, left.update, right.update)
    )
    const next = editWikiState(left.state, "# Page\n\nA 🌳 trees.", 101)
    expect(mergeWikiState(initial, next.update, left.update, right.update).body).toBe("# Page\n\nA 🌳 trees.\n\nNext")
    expect(Y.decodeStateVector(Y.encodeStateVectorFromUpdate(decodeWikiState(next.state))).size).toBe(2)
  })

  test("actual Yrs 0.27.4 deletion acknowledgements contain the submitted delta before and after a concurrent insertion", () => {
    // Captured by Plue's real native FFI with Yjs 13.6.32, 2026-09-09.
    expect(wikiStateContains(nativeDeletion.bootstrap.state, nativeDeletion.submittedDeletionDelta)).toBe(false)
    expect(wikiStateContains(nativeDeletion.acceptedDocument.state, nativeDeletion.submittedDeletionDelta)).toBe(true)
    expect(wikiStateContains(nativeDeletion.concurrentLaterDocument.state, nativeDeletion.submittedDeletionDelta)).toBe(
      true
    )
    expect(mergeWikiState(nativeDeletion.acceptedDocument.state).body).toBe(nativeDeletion.acceptedDocument.markdown)
  })

  test("UTF-8 Markdown and binary delta limits are enforced before a local edit is queued", () => {
    expect(() => editWikiState(stateOf("small"), "🌱".repeat(262145))).toThrow("1 MiB of Markdown")
    expect(() => wikiPagePath("owner/..", "home")).toThrow()
    expect(() => wikiPagePath("owner/repo", "../secret")).toThrow()
  })

  test("the existing proxy receives bounded SSE chunks and per-page replay identity", async () => {
    const frames = [
      ": connected\n\nevent: wiki.up",
      "date\nid: 7\ndata: {\"id\":7,\"page_id\":42,\"revision\":7,\"deleted\":false,\"slug\":\"new-name\"}\n\n"
    ]
    let request = ""
    const transport = makeCloudWikiTransport({
      baseUrl: "https://smithers.test",
      http: async (url) => {
        request = url
        return new Response(
          new ReadableStream({
            start(controller) {
              frames.forEach((frame) => controller.enqueue(new TextEncoder().encode(frame)))
              controller.close()
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      }
    })
    const events = await Effect.runPromise(Stream.runCollect(transport.revisions("owner/repo", "old-name", 42, 6)))
    expect(request).toContain("/api/repos/owner/repo/wiki/old-name/stream?page_id=42&after=6")
    expect(events).toEqual([{ id: 7, page_id: 42, revision: 7, deleted: false, slug: "new-name" }])
  })

  test("mismatched revision identity and revoked access fail instead of advancing the cursor", async () => {
    for (
      const frame of [
        "event: wiki.update\nid: 8\ndata: {\"id\":7,\"page_id\":42,\"revision\":7,\"deleted\":false,\"slug\":\"home\"}\n\n",
        "event: revoked\ndata: {}\n\n"
      ]
    ) {
      const transport = makeCloudWikiTransport({
        baseUrl: "",
        http: async () =>
          new Response(frame, {
            headers: { "content-type": "text/event-stream" }
          })
      })
      const result = await Effect.runPromise(
        Effect.result(Stream.runCollect(transport.revisions("owner/repo", "home", 42, 6)))
      )
      expect(result._tag).toBe("Failure")
    }
  })
})
