import { expect, type APIRequestContext } from "@playwright/test"
import { TIMELINE_SUMMARIES_ROUTE } from "../src/features/timeline/contract"
import { revisionOf } from "../src/features/timeline/identity"
import { writeHeaders } from "./target"

/** Store a deterministic summary through the real claims and persistence route. */
export const recordSummary = async (
  request: APIRequestContext,
  row: { id: string; role: "user" | "assistant"; text: string },
  summary: string,
) => {
  const key = {
    messageId: row.id,
    revision: revisionOf(row),
    owner: crypto.randomUUID(),
  }
  const headers = writeHeaders()
  await expect.poll(async () => {
    const claimed = await request.post(TIMELINE_SUMMARIES_ROUTE, {
      headers,
      data: { op: "claim", ...key, reason: row.role === "user" ? "question" : "answer" },
    })
    try {
      expect(claimed.status()).toBe(200)
      return (await claimed.json()).claimed
    } finally {
      await claimed.dispose()
    }
  }, { timeout: 10_000 }).toBe(true)
  const recorded = await request.post(TIMELINE_SUMMARIES_ROUTE, {
    headers,
    data: { op: "record", ...key, summary },
  })
  try {
    expect(recorded.status()).toBe(200)
    expect(await recorded.json()).toEqual({ recorded: true })
  } finally {
    await recorded.dispose()
  }
}
