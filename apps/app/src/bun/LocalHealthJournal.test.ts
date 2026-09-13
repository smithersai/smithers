import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openLocalHealthJournal } from "./LocalHealthJournal"

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
