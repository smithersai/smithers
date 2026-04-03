import { describe, expect, it } from "bun:test"

import { createLogger } from "@/logging/logger"
import { createApp } from "@/server/app"

type JsonRecord = Record<string, unknown>

function createMemoryDestination() {
  const chunks: string[] = []

  return {
    chunks,
    stream: {
      write(chunk: string | Uint8Array) {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      },
    },
  }
}

function parseJsonLines(chunks: string[]) {
  return chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord)
}

describe("app logging", () => {
  it("logs request lifecycle events with correlation metadata", async () => {
    const destination = createMemoryDestination()
    const logger = createLogger({
      destination: destination.stream,
      timestamp: false,
      level: "info",
    })

    const app = createApp({ logger })

    const response = await app.fetch(new Request("http://localhost:7332/api/settings", { method: "GET" }))

    expect(response.status).toBe(200)

    const entries = parseJsonLines(destination.chunks)
    const received = entries.find((entry) => entry.event === "http.request.received")
    const completed = entries.find((entry) => entry.event === "http.request.completed")

    expect(received).toBeDefined()
    expect(completed).toBeDefined()

    expect(received).toMatchObject({
      level: "info",
      service: "burns-daemon",
      method: "GET",
      path: "/api/settings",
      event: "http.request.received",
    })

    expect(completed).toMatchObject({
      level: "info",
      service: "burns-daemon",
      method: "GET",
      path: "/api/settings",
      statusCode: 200,
      event: "http.request.completed",
    })

    expect(typeof completed?.durationMs).toBe("number")
    expect(completed?.durationMs as number).toBeGreaterThanOrEqual(0)
    expect(completed?.requestId).toBe(received?.requestId)
  })
})
