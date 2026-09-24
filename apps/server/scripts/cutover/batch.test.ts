import { expect, test } from "bun:test"
import { exportBatch } from "./batch"

test("bounded export stops scheduling on failure and waits for every in-flight read", async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const started: number[] = [], finished: number[] = []
  let settled = false
  const job = exportBatch([0, 1, 2, 3], async value => {
    started.push(value)
    if (value === 1) throw new Error("version changed")
    await pending
    finished.push(value)
  }, 2).catch(error => { settled = true; return error as Error })
  await Promise.resolve(); await Promise.resolve()
  expect(started).toEqual([0, 1])
  expect(settled).toBe(false)
  release()
  expect((await job)?.message).toBe("version changed")
  expect(finished).toEqual([0])
})

test("successful bounded export visits each object exactly once", async () => {
  const seen: number[] = []
  await exportBatch([0, 1, 2, 3], async value => { seen.push(value) }, 2)
  expect(seen.sort()).toEqual([0, 1, 2, 3])
  expect(exportBatch([], async () => {}, 9)).rejects.toThrow("Invalid export concurrency")
})
