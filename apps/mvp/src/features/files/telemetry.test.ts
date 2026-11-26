import { Effect } from "effect"
import { expect, test } from "vitest"
import { openTestApp, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { Files } from "./files.vibe"

test("focus requests, consumption and drops reach the app's OTLP logs, spans and counts without paths", async () => {
  const runtime = openTestApp({ sessionLifecycle: false })
  const events = [
    { phase: "requested", reason: "keyboard" },
    { phase: "consumed", reason: "keyboard" },
    { phase: "dropped", reason: "disconnected" },
    { phase: "requested", reason: "restored" },
    { phase: "consumed", reason: "restored" },
    { phase: "dropped", reason: "outside" },
  ] as const
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  try {
    const files = await runtime.runPromise(Effect.service(Files))
    for (const event of events) files.actions.recordFocus(event)
  } finally {
    await runtime.dispose()
  }
  const records = read(api.telemetry)
  expect(records.log("files.focus").map((log) => log.attributes)).toEqual(events)
  expect(records.span("files.focus").map((span) => span.attributes)).toEqual(events)
  for (const event of events) {
    expect(records.points.filter((point) => point.metric === "smithers_web_file_focus")).toContainEqual(expect.objectContaining({ attributes: event, value: 1 }))
  }
})
