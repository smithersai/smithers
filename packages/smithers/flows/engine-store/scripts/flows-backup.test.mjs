/**
 * Verifies the operator's disaster-recovery entry point: argument parsing,
 * and a full backup → verify → restore round trip driven exactly the way an
 * operator drives it — spawned `node packages/smithers/flows/engine-store/scripts/flows-backup.mjs` invocations
 * against a real migrated store file.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseArguments } from "./flows-backup.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const script = join(repoRoot, "packages", "smithers", "flows", "engine-store", "scripts", "flows-backup.mjs")

test("parseArguments accepts the three invocations", () => {
  assert.deepEqual(parseArguments(["backup", "db.sqlite3", "backups/1"]), {
    command: "backup",
    databaseFile: "db.sqlite3",
    backupDirectory: "backups/1",
    objectsDirectory: undefined,
    maxFileSizeBytes: undefined
  })
  assert.deepEqual(parseArguments(["backup", "db.sqlite3", "backups/1", ".flows/objects"]), {
    command: "backup",
    databaseFile: "db.sqlite3",
    backupDirectory: "backups/1",
    objectsDirectory: ".flows/objects",
    maxFileSizeBytes: undefined
  })
  assert.deepEqual(parseArguments(["verify", "backups/1"]), {
    command: "verify",
    backupDirectory: "backups/1",
    maxFileSizeBytes: undefined
  })
  assert.deepEqual(parseArguments(["restore", "backups/1", "restored"]), {
    command: "restore",
    backupDirectory: "backups/1",
    targetDirectory: "restored",
    maxFileSizeBytes: undefined
  })
})

test("parseArguments passes --max-file-size to every command", () => {
  const limit = "2147483648"
  assert.equal(
    parseArguments(["backup", "db.sqlite3", "backups/1", ".flows/objects", "--max-file-size", limit]).maxFileSizeBytes,
    2_147_483_648
  )
  assert.equal(parseArguments(["verify", "backups/1", "--max-file-size", limit]).maxFileSizeBytes, 2_147_483_648)
  assert.equal(
    parseArguments(["restore", "backups/1", "restored", "--max-file-size", limit]).maxFileSizeBytes,
    2_147_483_648
  )
})

test("parseArguments refuses anything else", () => {
  for (
    const argv of [
      [],
      ["snapshot"],
      ["backup"],
      ["backup", "db.sqlite3"],
      ["backup", "db.sqlite3", "backups/1", "objects", "extra"],
      ["verify"],
      ["verify", "backups/1", "extra"],
      ["restore", "backups/1"],
      ["restore", "backups/1", "restored", "extra"],
      ["verify", "backups/1", "--max-file-size"],
      ["verify", "backups/1", "--max-file-size", "-1"],
      ["verify", "backups/1", "--max-file-size", "1.5"],
      ["verify", "--max-file-size", "10", "backups/1"]
    ]
  ) {
    assert.throws(() => parseArguments(argv), /usage:/)
  }
})

test("the script backs up, verifies, and restores a real store", async () => {
  const base = mkdtempSync(join(tmpdir(), "flows-backup-script-"))
  const databaseFile = join(base, "live", "store.sqlite3")
  mkdirSync(dirname(databaseFile), { recursive: true })

  // A migrated store with one artifact blob, prepared through the same layers
  // the engine composes.
  const [
    { DurableWriter },
    NodeDatabase,
    Migrations,
    { Effect, Layer }
  ] = await Promise.all([
    import("@smthrs/database"),
    import("@smthrs/database/node/NodeDatabase"),
    import("@smthrs/engine-store/Migrations"),
    import("effect")
  ])
  await Effect.runPromise(
    Effect.provide(
      Effect.void,
      Layer.provideMerge(
        Migrations.layer,
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: databaseFile }))
      )
    )
  )
  const objectsDirectory = join(base, "live", "objects")
  const blob = "operator-drill-artifact"
  const { createHash } = await import("node:crypto")
  const digest = createHash("sha256").update(blob).digest("hex")
  mkdirSync(join(objectsDirectory, digest.slice(0, 2)), { recursive: true })
  writeFileSync(join(objectsDirectory, digest.slice(0, 2), digest), blob)

  const invoke = (args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
    assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}`)
    return result.stdout
  }

  const backupDirectory = join(base, "backup")
  const backedUp = invoke(["backup", databaseFile, backupDirectory, objectsDirectory])
  assert.match(backedUp, /backed up \d+ database bytes/)
  assert.match(backedUp, /1 artifact blobs/)
  assert.ok(existsSync(join(backupDirectory, "manifest.json")))
  assert.ok(existsSync(join(backupDirectory, "store.sqlite3")))
  assert.ok(existsSync(join(backupDirectory, "objects", digest.slice(0, 2), digest)))

  const verified = invoke(["verify", backupDirectory])
  assert.match(verified, /backup verified/)

  const targetDirectory = join(base, "restored")
  const restored = invoke(["restore", backupDirectory, targetDirectory])
  assert.match(restored, /fenced it: 0 running runs suspended, 0 claims cleared/)
  assert.ok(existsSync(join(targetDirectory, "store.sqlite3")))
  assert.ok(existsSync(join(targetDirectory, "restored.json")))
  const manifest = JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8"))
  const marker = JSON.parse(readFileSync(join(targetDirectory, "restored.json"), "utf8"))
  assert.equal(marker.backupCreatedAtMs, manifest.createdAtMs)
  assert.equal(marker.databaseSha256, manifest.database.sha256)
})
