import { describe, expect, it } from "bun:test"

import { createLogger } from "@/logging/logger"

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

describe("logger", () => {
  it("emits structured json logs with standard metadata", () => {
    const destination = createMemoryDestination()
    const logger = createLogger({
      destination: destination.stream,
      timestamp: false,
      level: "info",
    })

    logger.info({ event: "unit.test", workspaceId: "ws-1" }, "logger smoke test")

    const entries = parseJsonLines(destination.chunks)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: "info",
      service: "mr-burns-daemon",
      event: "unit.test",
      workspaceId: "ws-1",
      message: "logger smoke test",
    })
  })
})
