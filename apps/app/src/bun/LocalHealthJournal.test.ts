import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openLocalHealthJournal } from "./LocalHealthJournal"
import { Option } from "effect"

test("health evidence survives owner restart and retains an ordered replay cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-health-journal-"))
  let journal = await openLocalHealthJournal(directory)
  try {
    const first = await journal.append("session:a", "owner:one", "control.status.observed", { health: "unknown" })
    await journal.close()
    journal = await openLocalHealthJournal(directory)
    const second = await journal.append("session:a", "owner:two", "control.status.observed", { health: "healthy" })
    expect(second).toBeGreaterThan(first)
    const replay = await journal.entries("session:a", first)
    expect(replay.entries).toHaveLength(1)
    expect(replay.entries[0]?.payload).toEqual({ health: "healthy" })
    expect((await journal.entries("session:other")).entries).toHaveLength(0)
  } finally {
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("oversized health evidence is refused before allocating a durable cursor", async () => {
  const journal = await openLocalHealthJournal()
  try {
    await expect(journal.append("session:a", "owner:one", "control.status.observed", { detail: "x".repeat(9000) }))
      .rejects.toThrow()
    expect((await journal.entries("session:a")).entries).toHaveLength(0)
  } finally {
    await journal.close()
  }
})

test("long-lived heartbeat history compacts to a replayable checkpoint", async () => {
  const journal = await openLocalHealthJournal()
  try {
    let last = 0
    for (let beat = 0; beat < 270; beat += 1) {
      last = await journal.append("session:a", "owner:one", "control.status.observed", { beat })
    }
    const checkpoint = Option.getOrThrow(await journal.checkpoint("session:a"))
    expect(checkpoint.state).toMatchObject({ observation: { beat: 255 } })
    const tail = await journal.entries("session:a", checkpoint.seq)
    expect(tail.entries.length).toBeLessThan(20)
    expect(Number(tail.entries.at(-1)?.seq)).toBe(last)
    expect(tail.entries.at(-1)?.payload).toEqual({ beat: 269 })
  } finally { await journal.close() }
})
