import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { quickstart } from "../examples/quickstart.vibe"
import * as DurableWriter from "../src/DurableWriter.vibe"

describe("examples", () => {
  const directories: Array<string> = []
  const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), "database-quickstart-"))
    directories.push(directory)
    return join(directory, "notes.sqlite")
  }

  // The quickstart is a SQLite program; an operator's PostgreSQL settings
  // must not redirect it to a shared server.
  beforeEach(() => {
    vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it("quickstart applies notes_initial as global id 1, reads the row back, and counts 1 then 0", async () => {
    expect(await quickstart(scratch())).toEqual({
      applied: [[1, "notes_initial"]],
      bodies: ["hello"],
      ledger: [{ migration_id: 1, name: "notes_initial" }],
      deleted: [1, 0]
    })
  })

  it("quickstart rerun on the same file applies no migration and keeps one ledger row", async () => {
    const filename = scratch()
    await quickstart(filename)
    const second = await quickstart(filename)
    expect(second.applied).toEqual([])
    expect(second.ledger).toEqual([{ migration_id: 1, name: "notes_initial" }])
    expect(second.deleted).toEqual([1, 0])
  })

  it("quickstart insert over a surviving row fails as a constraint, not a replayed busy", async () => {
    const filename = scratch()
    await quickstart(filename)
    const db = new DatabaseSync(filename)
    db.exec("INSERT INTO notes (id, body) VALUES ('first', 'left behind')")
    db.close()
    const failure = await quickstart(filename).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(DurableWriter.codeOf(failure)).toBe("constraint")
  })
})
