import { existsSync } from "node:fs"
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { stackName } from "../deployment.ts"
import {
  openRemoteState as openPreStageRemoteState,
  stateObjectKey as preStageStateObjectKey
} from "../worker/test/fixtures/pre-stage-remote-state.ts"
import {
  legacyStateObjectKey,
  memoryStateBucket,
  migrateSharedState,
  remoteStateCommand,
  restoreSharedState,
  sharedStateBackupKey,
  type StateBucket,
  stateBucketName,
  stateObjectKey
} from "./remote-state.ts"

const holder = { host: "operator-host", pid: 4242, startedAt: "2026-11-19T00:00:00.000Z" }

const snapshotOf = (files: Record<string, string>): string =>
  JSON.stringify({ format: "smithers-alchemy-state/1", files }, null, 2)

/** The shared object as the live bucket holds it: every stage under one key. */
const shared = snapshotOf({
  "prod/CacheWorker.json": `{"prod":true}`,
  "prod/__stack_output__.json": `{"url":"https://build.smithers.sh"}`,
  "vibelang/CacheWorker.json": `{"vibelang":true}`,
  "vibelang/SandboxWorker.json": `{"sandbox":true}`
})

const prodSnapshot = snapshotOf({
  "CacheWorker.json": `{"prod":true}`,
  "__stack_output__.json": `{"url":"https://build.smithers.sh"}`
})
const vibelangSnapshot = snapshotOf({ "CacheWorker.json": `{"vibelang":true}`, "SandboxWorker.json": `{"sandbox":true}` })

/** A bucket that records every operation, so a test can name what was touched. */
const recordingBucket = (): StateBucket & {
  readonly objects: Map<string, { body: string; etag: string }>
  readonly operations: Array<string>
} => {
  const bucket = memoryStateBucket()
  const operations: Array<string> = []
  return {
    objects: bucket.objects,
    operations,
    get: async (key) => (operations.push(`GET ${key}`), bucket.get(key)),
    put: async (key, body, condition) => (operations.push(`PUT ${key}`), bucket.put(key, body, condition)),
    delete: async (key) => (operations.push(`DELETE ${key}`), bucket.delete(key))
  }
}

/** A bucket already split by the migration. */
const migratedBucket = async (): Promise<ReturnType<typeof recordingBucket>> => {
  const bucket = recordingBucket()
  await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
  await migrateSharedState(bucket, directory, holder)
  bucket.operations.length = 0
  return bucket
}

/** The local stack state directory of the machine running the migration. */
let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(NodePath.join(tmpdir(), "smithers-state-migration-")))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("per-stage state keys", () => {
  it("names one object per stage beside the shared object it replaces and its backup", () => {
    expect(legacyStateObjectKey).toBe(`alchemy/${stackName}.json`)
    expect(sharedStateBackupKey).toBe(`alchemy/${stackName}.pre-split.json`)
    expect(stateObjectKey("prod")).toBe(`alchemy/${stackName}/prod.json`)
    expect(stateObjectKey("needlefish_poc")).toBe(`alchemy/${stackName}/needlefish_poc.json`)
  })

  it.each(["", "..", "../prod", "a/b", "-x", "dev.user"])("refuses %j, which is not a stage name", (stage) => {
    expect(() => stateObjectKey(stage)).toThrow(TypeError)
  })
})

describe("migrateSharedState", () => {
  it("backs up the shared object, splits it under its lock, reads every copy back, then marks it migrated", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    bucket.operations.length = 0

    const result = await migrateSharedState(bucket, directory, holder)

    expect(result).toEqual({
      shared: "split",
      backup: "create",
      stages: [
        { stage: "prod", key: stateObjectKey("prod"), files: 2, action: "create" },
        { stage: "vibelang", key: stateObjectKey("vibelang"), files: 2, action: "create" }
      ]
    })
    expect(bucket.objects.get(sharedStateBackupKey)!.body).toBe(shared)
    expect(bucket.objects.get(stateObjectKey("prod"))!.body).toBe(prodSnapshot)
    expect(bucket.objects.get(stateObjectKey("vibelang"))!.body).toBe(vibelangSnapshot)
    expect(JSON.parse(bucket.objects.get(legacyStateObjectKey)!.body)).toEqual({
      format: "smithers-alchemy-state-migrated/1",
      stages: [stateObjectKey("prod"), stateObjectKey("vibelang")]
    })
    // The backup is written first, and the shared object is replaced only
    // after the backup and both stage objects read back as written.
    expect(bucket.operations).toEqual([
      `PUT ${legacyStateObjectKey}.lock`,
      `GET ${legacyStateObjectKey}`,
      `GET ${sharedStateBackupKey}`,
      `GET ${stateObjectKey("prod")}`,
      `GET ${stateObjectKey("vibelang")}`,
      `PUT ${sharedStateBackupKey}`,
      `PUT ${stateObjectKey("prod")}`,
      `PUT ${stateObjectKey("vibelang")}`,
      `GET ${sharedStateBackupKey}`,
      `GET ${stateObjectKey("prod")}`,
      `GET ${stateObjectKey("vibelang")}`,
      `PUT ${legacyStateObjectKey}`,
      `DELETE ${legacyStateObjectKey}.lock`
    ])
  })

  /**
   * The split is the migration's whole point, and a wrapper of the old layout
   * that pulled the marker as state would deploy against nothing. This runs
   * that wrapper's own remote-state code against the migrated bucket.
   */
  it("is refused by the remote-state code of a wrapper from before per-stage state", async () => {
    const bucket = await migratedBucket()
    const marker = bucket.objects.get(legacyStateObjectKey)!
    const working = NodePath.join(directory, "old-wrapper")

    expect(preStageStateObjectKey).toBe(legacyStateObjectKey)
    await expect(openPreStageRemoteState({ bucket, key: preStageStateObjectKey }, working, holder)).rejects.toThrow(
      "remote Alchemy state is not a smithers-alchemy-state/1 snapshot"
    )
    expect(bucket.objects.get(legacyStateObjectKey)).toEqual(marker)
    expect(bucket.objects.has(`${legacyStateObjectKey}.lock`)).toBe(false)
    // It refused before it created or wrote anything locally.
    expect(existsSync(working)).toBe(false)
  })

  it("is idempotent: a second run finds the marker and writes nothing", async () => {
    const bucket = await migratedBucket()
    const before = new Map(bucket.objects)

    expect(await migrateSharedState(bucket, directory, holder)).toEqual({ shared: "migrated", stages: [] })
    expect(bucket.objects).toEqual(before)
  })

  it("finishes a run that stopped after the backup and some stage objects were written", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    await bucket.put(sharedStateBackupKey, shared, { ifAbsent: true })
    await bucket.put(stateObjectKey("prod"), prodSnapshot, { ifAbsent: true })
    const prodEtag = bucket.objects.get(stateObjectKey("prod"))!.etag

    const result = await migrateSharedState(bucket, directory, holder)

    expect(result.backup).toBe("exists")
    expect(result.stages.map((entry) => [entry.stage, entry.action])).toEqual([["prod", "exists"], [
      "vibelang",
      "create"
    ]])
    expect(bucket.objects.get(stateObjectKey("prod"))!.etag).toBe(prodEtag)
    expect(bucket.objects.has(stateObjectKey("vibelang"))).toBe(true)
  })

  it("reports what it would do on a dry run, and takes no lock and writes nothing", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    const before = new Map(bucket.objects)
    bucket.operations.length = 0

    const result = await migrateSharedState(bucket, directory, holder, { dryRun: true })

    expect(result.backup).toBe("create")
    expect(result.stages.map((entry) => entry.action)).toEqual(["create", "create"])
    expect(bucket.objects).toEqual(before)
    expect(bucket.operations.every((operation) => operation.startsWith("GET "))).toBe(true)
  })

  it("has nothing to do when no shared object exists", async () => {
    const bucket = recordingBucket()
    expect(await migrateSharedState(bucket, directory, holder)).toEqual({ shared: "absent", stages: [] })
    expect(bucket.objects.size).toBe(0)
  })

  it.each([
    [
      "a stage object that already holds different state",
      stateObjectKey("vibelang"),
      `${stateBucketName}/${stateObjectKey("vibelang")} already holds state that differs from the shared object's vibelang files`
    ],
    [
      "a backup that holds a different copy",
      sharedStateBackupKey,
      `${stateBucketName}/${sharedStateBackupKey} already holds a different copy of the shared state`
    ]
  ])("refuses %s, and writes nothing", async (_case, key, message) => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    await bucket.put(key, snapshotOf({ "CacheWorker.json": `{"newer":true}` }), { ifAbsent: true })
    const before = new Map(bucket.objects)

    await expect(migrateSharedState(bucket, directory, holder)).rejects.toThrow(message)
    expect(bucket.objects).toEqual(before)
  })

  it.each([
    ["the backup", sharedStateBackupKey],
    ["a stage object", stateObjectKey("vibelang")]
  ])("keeps the shared object when %s does not read back as written", async (_case, key) => {
    const memory = recordingBucket()
    await memory.put(legacyStateObjectKey, shared, { ifAbsent: true })
    const corrupting: StateBucket = {
      ...memory,
      get: async (target) => {
        const object = await memory.get(target)
        return target === key && object !== undefined ? { ...object, body: object.body.slice(1) } : object
      }
    }

    await expect(migrateSharedState(corrupting, directory, holder)).rejects.toThrow(
      `${stateBucketName}/${key} does not read back as it was written`
    )
    expect(memory.objects.get(legacyStateObjectKey)!.body).toBe(shared)
    expect(memory.objects.has(`${legacyStateObjectKey}.lock`)).toBe(false)
  })

  /**
   * A wrapper of the shared layout that could not publish left local state
   * the shared object lacks. Splitting without it would drop the resources
   * that run created from every stage object.
   */
  it("refuses while this machine holds unpublished state from the shared layout, on a dry run too", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    const marker = NodePath.join(directory, ".smithers-unpublished-state")
    await writeFile(marker, JSON.stringify({ format: "smithers-unpublished-state/1", etag: '"1"', baseline: "x" }))
    bucket.operations.length = 0

    for (const dryRun of [false, true]) {
      await expect(migrateSharedState(bucket, directory, holder, { dryRun })).rejects.toThrow(
        `${marker} records state a deployment from this machine never published; before migrating, deploy once ` +
          `more from this machine with a revision from before per-stage state`
      )
    }
    expect(bucket.operations).toEqual([])
  })

  it.each([
    ["a file outside any stage", snapshotOf({ "CacheWorker.json": "{}" })],
    ["a stage name the wrapper refuses", snapshotOf({ "-x/CacheWorker.json": "{}" })],
    ["a body that is not a snapshot", "not json"]
  ])("refuses %s and releases the shared lock", async (_case, body) => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, body, { ifAbsent: true })

    await expect(migrateSharedState(bucket, directory, holder)).rejects.toThrow(TypeError)
    expect(bucket.objects.get(legacyStateObjectKey)!.body).toBe(body)
    expect(bucket.objects.has(`${legacyStateObjectKey}.lock`)).toBe(false)
  })

  it("refuses while a deployment of the old layout holds the shared lock", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    await bucket.put(`${legacyStateObjectKey}.lock`, JSON.stringify({ host: "ci", pid: 9, startedAt: "then" }), {
      ifAbsent: true
    })

    await expect(migrateSharedState(bucket, directory, holder)).rejects.toThrow("locked by ci pid 9")
    expect(bucket.objects.has(stateObjectKey("prod"))).toBe(false)
  })

  it.each([
    ["the backup", sharedStateBackupKey],
    ["a stage object", stateObjectKey("prod")],
    ["the shared object", legacyStateObjectKey]
  ])("refuses when %s is written during the migration", async (_case, key) => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    const racing: StateBucket = {
      ...bucket,
      put: async (target, body, condition) => target === key ? false : bucket.put(target, body, condition)
    }

    await expect(migrateSharedState(racing, directory, holder)).rejects.toThrow(
      `${key} changed during the migration`
    )
    expect(bucket.objects.get(legacyStateObjectKey)!.body).toBe(shared)
    expect(bucket.objects.has(`${legacyStateObjectKey}.lock`)).toBe(false)
  })

  it("reports both failures when the shared lock cannot be released after a refusal", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, "not json", { ifAbsent: true })
    const stuck: StateBucket = {
      ...bucket,
      delete: async () => {
        throw new Error("R2 state DELETE answered 503")
      }
    }

    await expect(migrateSharedState(stuck, directory, holder)).rejects.toThrow(
      /not JSON; Remote Alchemy state lock was not released: R2 state DELETE answered 503/
    )
  })
})

describe("restoreSharedState", () => {
  it("puts the backup back as the shared object and deletes the stage objects the migration wrote", async () => {
    const bucket = await migratedBucket()

    expect(await restoreSharedState(bucket, holder)).toEqual({
      shared: "restored",
      deleted: [{ stage: "prod", key: stateObjectKey("prod") }, { stage: "vibelang", key: stateObjectKey("vibelang") }]
    })
    expect(bucket.objects.get(legacyStateObjectKey)!.body).toBe(shared)
    expect(bucket.objects.get(sharedStateBackupKey)!.body).toBe(shared)
    expect([...bucket.objects.keys()].sort()).toEqual([legacyStateObjectKey, sharedStateBackupKey].sort())
    expect(bucket.operations[0]).toBe(`PUT ${legacyStateObjectKey}.lock`)
    expect(bucket.operations.at(-1)).toBe(`DELETE ${legacyStateObjectKey}.lock`)

    // A wrapper of the old layout deploys from it again.
    const working = NodePath.join(directory, "old-wrapper")
    const session = await openPreStageRemoteState({ bucket, key: preStageStateObjectKey }, working, holder)
    await session.release()
    expect((await readdir(working)).sort()).toEqual([".smithers-unpublished-state", "prod", "vibelang"])
  })

  it("is idempotent, and finishes a run that stopped after the shared object was restored", async () => {
    const bucket = await migratedBucket()
    await restoreSharedState(bucket, holder)
    expect(await restoreSharedState(bucket, holder)).toEqual({ shared: "kept", deleted: [] })

    const partial = await migratedBucket()
    await partial.put(legacyStateObjectKey, shared, { ifMatch: partial.objects.get(legacyStateObjectKey)!.etag })
    expect(await restoreSharedState(partial, holder)).toEqual({
      shared: "kept",
      deleted: [{ stage: "prod", key: stateObjectKey("prod") }, { stage: "vibelang", key: stateObjectKey("vibelang") }]
    })
    expect(partial.objects.has(stateObjectKey("prod"))).toBe(false)
  })

  it("restores a shared object that was deleted, and leaves stage objects that are already gone", async () => {
    const bucket = await migratedBucket()
    bucket.objects.delete(legacyStateObjectKey)
    bucket.objects.delete(stateObjectKey("vibelang"))

    expect(await restoreSharedState(bucket, holder)).toEqual({
      shared: "restored",
      deleted: [{ stage: "prod", key: stateObjectKey("prod") }]
    })
    expect(bucket.objects.get(legacyStateObjectKey)!.body).toBe(shared)
  })

  it("reports what it would do on a dry run, and takes no lock and writes nothing", async () => {
    const bucket = await migratedBucket()
    const before = new Map(bucket.objects)

    expect((await restoreSharedState(bucket, holder, { dryRun: true })).shared).toBe("restored")
    expect(bucket.objects).toEqual(before)
    expect(bucket.operations.every((operation) => operation.startsWith("GET "))).toBe(true)
  })

  it.each([
    [
      "a stage deployed after the migration",
      async (bucket: ReturnType<typeof recordingBucket>) => {
        const key = stateObjectKey("prod")
        await bucket.put(key, snapshotOf({ "CacheWorker.json": "{}" }), { ifMatch: bucket.objects.get(key)!.etag })
      },
      `${stateBucketName}/${stateObjectKey("prod")} changed since the migration: stage prod was deployed`
    ],
    [
      "a missing backup",
      async (bucket: ReturnType<typeof recordingBucket>) => void bucket.objects.delete(sharedStateBackupKey),
      `${stateBucketName}/${sharedStateBackupKey} does not exist`
    ],
    [
      "a shared object that is neither the marker nor the backup",
      async (bucket: ReturnType<typeof recordingBucket>) => {
        await bucket.put(legacyStateObjectKey, snapshotOf({ "prod/Other.json": "{}" }), {
          ifMatch: bucket.objects.get(legacyStateObjectKey)!.etag
        })
      },
      `${stateBucketName}/${legacyStateObjectKey} holds neither the migration marker nor its backup`
    ]
  ])("refuses %s before it writes anything", async (_case, arrange, message) => {
    const bucket = await migratedBucket()
    await arrange(bucket)
    const before = new Map(bucket.objects)

    await expect(restoreSharedState(bucket, holder)).rejects.toThrow(message)
    expect(bucket.objects).toEqual(before)
  })

  it("refuses to delete a stage object that changed during the restore", async () => {
    const bucket = await migratedBucket()
    const key = stateObjectKey("prod")
    let reads = 0
    const racing: StateBucket = {
      ...bucket,
      get: async (target) => {
        if (target === key && ++reads === 2) {
          await bucket.put(key, prodSnapshot, { ifMatch: bucket.objects.get(key)!.etag })
        }
        return bucket.get(target)
      }
    }

    await expect(restoreSharedState(racing, holder)).rejects.toThrow(
      `${stateBucketName}/${key} changed during the restore; run it again`
    )
    expect(bucket.objects.has(key)).toBe(true)
  })
})

describe("remoteStateCommand", () => {
  const capture = async (
    args: ReadonlyArray<string>,
    bucket: StateBucket
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
    const out: Array<string> = []
    const err: Array<string> = []
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true))
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true))
    try {
      const code = await remoteStateCommand(args, { stateBucket: async () => bucket, stateDirectory: directory })
      return { code, stdout: out.join(""), stderr: err.join("") }
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  }
  const name = (key: string): string => `${stateBucketName}/${key}`

  it("previews, migrates, reports nothing left, then previews and runs the restore", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, shared, { ifAbsent: true })
    // Another operator already wrote one stage's object with the same files.
    await bucket.put(stateObjectKey("vibelang"), vibelangSnapshot, { ifAbsent: true })

    expect(await capture(["migrate", "--", "--dry-run"], bucket)).toEqual({
      code: 0,
      stdout: `Would copy ${name(legacyStateObjectKey)} to ${name(sharedStateBackupKey)}.\n` +
        `Would create ${name(stateObjectKey("prod"))} for stage prod (2 files).\n` +
        `Would keep ${name(stateObjectKey("vibelang"))} for stage vibelang (2 files).\n` +
        `Would replace ${name(legacyStateObjectKey)} with a migration marker.\n`,
      stderr: ""
    })
    expect(bucket.objects.has(stateObjectKey("prod"))).toBe(false)

    expect((await capture(["migrate"], bucket)).stdout).toBe(
      `Copied ${name(legacyStateObjectKey)} to ${name(sharedStateBackupKey)}.\n` +
        `Created ${name(stateObjectKey("prod"))} for stage prod (2 files).\n` +
        `Kept ${name(stateObjectKey("vibelang"))} for stage vibelang (2 files).\n` +
        `Replaced ${name(legacyStateObjectKey)} with a migration marker.\n`
    )
    expect((await capture(["migrate"], bucket)).stdout).toBe(
      `${name(legacyStateObjectKey)} is already a migration marker; nothing to migrate.\n`
    )
    expect((await capture(["migrate"], recordingBucket())).stdout).toBe(
      `${name(legacyStateObjectKey)} does not exist; nothing to migrate.\n`
    )

    expect((await capture(["restore", "--dry-run"], bucket)).stdout).toBe(
      `Would restore ${name(legacyStateObjectKey)} from ${name(sharedStateBackupKey)}.\n` +
        `Would delete ${name(stateObjectKey("prod"))} for stage prod.\n` +
        `Would delete ${name(stateObjectKey("vibelang"))} for stage vibelang.\n`
    )
    expect((await capture(["restore"], bucket)).stdout).toBe(
      `Restored ${name(legacyStateObjectKey)} from ${name(sharedStateBackupKey)}.\n` +
        `Deleted ${name(stateObjectKey("prod"))} for stage prod.\n` +
        `Deleted ${name(stateObjectKey("vibelang"))} for stage vibelang.\n`
    )
    expect((await capture(["restore"], bucket)).stdout).toBe(`${name(legacyStateObjectKey)} already holds the backup.\n`)

    // A second migration finds the backup it wrote the first time.
    expect((await capture(["migrate", "--dry-run"], bucket)).stdout).toContain(
      `${name(sharedStateBackupKey)} already holds a copy of ${name(legacyStateObjectKey)}.\n`
    )
  })

  it.each([[[]], [["migrate", "--yes"]], [["split"]], [["restore", "prod"]]])("refuses %j with its usage", async (args) => {
    const result = await capture(args, recordingBucket())
    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "usage: node scripts/remote-state.ts migrate|restore [--dry-run]\n"
    })
  })

  it("reports a failed migration or restore and its cause", async () => {
    const bucket = recordingBucket()
    await bucket.put(legacyStateObjectKey, "not json", { ifAbsent: true })
    const migration = await capture(["migrate"], bucket)
    expect(migration.code).toBe(1)
    expect(migration.stderr).toBe("State migration failed: remote Alchemy state is not JSON\n")

    const restore = await capture(["restore"], bucket)
    expect(restore.code).toBe(1)
    expect(restore.stderr).toBe(`State restore failed: ${name(sharedStateBackupKey)} does not exist, so there is nothing to restore from\n`)
  })

  it("reaches the production bucket with the deploying shell's Cloudflare credentials by default", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "")
    const err: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (err.push(String(chunk)), true))
    try {
      expect(await remoteStateCommand(["migrate"])).toBe(1)
      expect(err.join("")).toBe(
        "State migration failed: CLOUDFLARE_API_TOKEN is required to reach the R2 state bucket\n"
      )
    } finally {
      stderr.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

