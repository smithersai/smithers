/** Verifies the exact injected workload before a subscriber memory sample. */
import { ControlRuntime, type ControlSchema } from "@smthrs/control"

export const signalDelivery = (runId: string, count: number, prefix = "tick") => {
  const expected = Array.from({ length: count }, (_, index) => `${prefix}:${runId}:${index}`)
  const expectedSet = new Set(expected)
  const seen = new Map<string, number>()
  let cursor = 0
  return {
    observe: (event: ControlSchema.ControlEvent) => {
      if (event.kind !== "control.signal.admitted" || event.runId !== runId) return
      const payload = event.payload as { commandId?: unknown; runId?: unknown; name?: unknown } | null
      if (typeof payload?.commandId !== "string" || payload.runId !== runId || payload.name !== prefix) {
        throw new Error("Signal admission has an unexpected identity")
      }
      const id = ControlRuntime.signalReceiptId(payload.commandId)
      if (!expectedSet.has(id)) throw new Error(`Unexpected signal admission ${id}`)
      if (seen.has(id)) throw new Error(`Duplicate signal admission ${id}`)
      if (event.sequence <= cursor) throw new Error("Signal admissions did not advance the journal cursor")
      seen.set(id, event.sequence)
      cursor = event.sequence
    },
    complete: () => seen.size === expected.length,
    snapshot: () => ({ identities: [...seen.keys()].sort(), cursor }),
    expected: [...expected].sort()
  }
}
