import { Migrations } from "@smthrs/effect-tanstack-db"
import { Schema } from "effect"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { Unsent } from "../features/chat/schema"
import { listed } from "../features/runs/contract"
import { RepositoryV3 } from "./repo-history"
import { RunV1, RunV2 } from "./runs-history"
import { FileTabRowV1, UnsentV1 } from "./history"
import { ChatUnsentStore, deviceRegistry, IssueRequestedStore } from "./registry"

// The check that fails a persisted schema changed without a new version (decision 0021 §5): every store and outbox
// payload the device keeps, by version, against schemas.lock.json. A new version is recorded with
// `UPDATE_DEVICE_SCHEMAS=1 pnpm vitest run src/device/schemas.test.ts`, which never rewrites a recorded one.

const lockPath = new URL("./schemas.lock.json", import.meta.url)

const read = (): Migrations.Snapshot | undefined =>
  existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as Migrations.Snapshot) : undefined

/** What to do about each problem, in words a person changing a schema acts on. */
const advice: Record<Migrations.Problem["problem"], string> = {
  changed_without_version:
    "its schema changed: add a new version (a synced store bumps `version`; a local store or payload appends the new schema and a migration to it)",
  history_changed: "an older version's schema was edited: restore it; old shapes live in src/device/history.ts",
  version_went_back: "its version is lower than one a build already stored",
  kind_changed: "it changed between local and synced: declare a new id and retire this one",
  removed: "it is no longer declared: declare it with `Migrations.retired` so its rows are kept, not lost",
  mutation_removed: "an outbox mutation disappeared: rename it (`renamed`) or retire it (`retired`) so its writes park",
  unrecorded: "a new version: record it with UPDATE_DEVICE_SCHEMAS=1 and commit schemas.lock.json",
}

const explain = (problems: ReadonlyArray<Migrations.Problem>) =>
  problems.map(({ problem, store, version }) => `${store}${version === undefined ? "" : ` v${version}`}: ${advice[problem]}`)

describe("the device's stores", () => {
  test("preserves the deployed repository v3 schema", () => {
    expect(Migrations.fingerprint(RepositoryV3)).toBe(read()!.stores["repo-repositories"]!.versions["3"])
  })

  test("preserves the deployed runs v1 schema", () => {
    expect(Migrations.fingerprint(RunV1)).toBe(read()!.stores["runs"]!.versions["1"])
  })

  test("preserves the deployed file tabs v1 schema", () => {
    expect(Migrations.fingerprint(FileTabRowV1)).toBe(read()!.stores["file-tabs"]!.versions["1"])
  })

  test("preserves the deployed runs v2 schema", () => {
    expect(Migrations.fingerprint(RunV2)).toBe(read()!.stores["runs"]!.versions["2"])
  })

  test("match the lock: no persisted schema changed without a new version, and none disappeared", () => {
    if (process.env["UPDATE_DEVICE_SCHEMAS"] === "1") {
      const { lock, refused } = Migrations.lock(deviceRegistry, read())
      expect(explain(refused)).toEqual([])
      writeFileSync(lockPath, `${JSON.stringify(Migrations.snapshot(lock), null, 2)}\n`)
    }
    expect(explain(Migrations.check(deviceRegistry, read()))).toEqual([])
  })

  test("the check fails a store whose schema changed at the same version, and names what to do", () => {
    const Changed = Schema.Struct({ ...Unsent.fields, pinned: Schema.Boolean })
    const changed = Migrations.registry({
      ...deviceRegistry,
      stores: deviceRegistry.stores.map((store) =>
        store === ChatUnsentStore
          ? Migrations.local({
            id: "chat-unsent",
            versions: [UnsentV1, Changed],
            migrations: [Migrations.step(UnsentV1, Changed, (row) => ({ ...row, pinned: false }))],
            getKey: (row) => row.id,
          })
          : store
      ),
    })
    expect(explain(Migrations.check(changed, read()))).toEqual([`chat-unsent v2: ${advice.changed_without_version}`])
  })

  test("a local store's new version can't be declared without a migration to it", () => {
    const Changed = Schema.Struct({ ...Unsent.fields, pinned: Schema.Boolean })
    expect(() =>
      Migrations.local({ id: "chat-unsent", versions: [Unsent, Changed], getKey: (row) => row.id })
    ).toThrow("2 versions need 1 migrations, not 0")
  })

  test("the check fails a store that was deleted rather than retired, and an edited old shape", () => {
    const withoutRequested = Migrations.registry({
      ...deviceRegistry,
      stores: deviceRegistry.stores.filter((store) => store !== IssueRequestedStore),
    })
    expect(explain(Migrations.check(withoutRequested, read()))).toEqual([`issue-requested: ${advice.removed}`])
  })

  test("every outbox mutation has a payload version; the lock has no handwritten epoch", () => {
    expect(deviceRegistry.outbox.mutations).toEqual(["ask", "issue-write", "text-update", "todo-op", "run-steer"])
    expect(read()).not.toHaveProperty("epoch")
    expect(Migrations.snapshot(read()!)).toEqual(read())
  })
})

describe("the host's preparation of the device", () => {
  test("is not work a person lists among their runs", () => {
    expect(listed("device/prepare")).toBe(false)
    expect(listed("chat/Answer")).toBe(true)
  })
})
