/** Independent byte-boundary oracle shared by the full gate and mutation tier. */
import { expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import type { ControlEvent } from "@smthrs/control/ControlSchema"
import { Effect, Stream } from "effect"
import * as Projections from "../src/Projections.ts"

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8")

const journalEvent = (sequence: number, payload: string): ControlEvent => ({
  sequence,
  kind: "control.test",
  runId: "byte-oracle",
  occurredAt: sequence,
  payload
})

for (const offset of [-1, 0, 1]) {
  it.effect(`mutation contract: run-events pages at byte limit ${offset}`, () =>
    Effect.gen(function*() {
      // The public 4 MiB contract is independent of the implementation constant.
      const limit = 4 * 1024 * 1024
      const target = limit + offset
      // Each event stays inside the per-event budget, so nothing here is
      // clipped and the oracle measures the page boundary alone.
      const rows: Array<ControlEvent> = []
      // Sizes accumulate rather than being re-measured over the whole array:
      // an encoded array is its members plus one separator each after the first.
      let total = 2
      const push = (candidate: ControlEvent): void => {
        total += bytes(candidate) + (rows.length === 0 ? 0 : 1)
        rows.push(candidate)
      }
      push(journalEvent(1, "café😀\"\n"))
      let sequence = 2
      for (;;) {
        const candidate = journalEvent(sequence, "x".repeat(8_000))
        if (total + bytes(candidate) + 1 > target - 200) break
        push(candidate)
        sequence += 1
      }
      push(journalEvent(sequence, "x".repeat(target - total - bytes(journalEvent(sequence, "")) - 1)))
      expect(bytes(rows)).toBe(target)
      const service = {
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ runId: "byte-oracle", flowId: "fixture", status: "running", createdAt: 1, updatedAt: 2 }]
          }),
        watch: (filter: { readonly afterSequence?: number | undefined }) =>
          Stream.fromIterable(
            filter.afterSequence === undefined
              ? rows
              : rows.filter((row) => row.sequence > filter.afterSequence!)
          )
      } as unknown as ControlService
      const projection = yield* Projections.make(service)
      const selector = { _tag: "run-events" as const, runId: "byte-oracle" }
      const page = yield* projection.snapshot(selector)
      expect(bytes(page.rows)).toBeLessThanOrEqual(limit)
      if (offset <= 0) {
        expect(page.rows).toEqual(rows)
        expect(page.cursor.value).toBe(rows.at(-1)?.sequence)
        // A page at the head answers nothing more rather than refusing.
        expect((yield* projection.snapshot(selector, page.cursor)).rows).toEqual([])
      } else {
        // One byte over splits the read rather than refusing it, and the
        // cursor the first page carries reaches the remainder.
        expect(page.rows.length).toBe(rows.length - 1)
        const rest = yield* projection.snapshot(selector, page.cursor)
        expect([...page.rows, ...rest.rows]).toEqual(rows)
      }
    }))
}
