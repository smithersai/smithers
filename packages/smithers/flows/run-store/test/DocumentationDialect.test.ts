import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["guides/compose-the-stores.md", "installation.md"])(
  "%s states the SQLite and serialized-writer requirements",
  (page) => {
    const text = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8").replace(/\s+/g, " ")

    expect(text).not.toContain("anything that provides `SqlClient` works")
    expect(text).toContain("SQLite and PostgreSQL")
    expect(text).toContain("`DurableWriter` serialization contract")
    expect(text).toContain("`PostgresDatabase`")
    expect(text).toContain("READ COMMITTED")
  }
)

it("composes journal migrations before the run-store migration set", () => {
  const text = readFileSync(new URL("../docs/guides/compose-the-stores.md", import.meta.url), "utf8")
    .replace(/\s+/g, " ")

  expect(text).toContain("import * as JournalMigrations from \"@smthrs/journal/Migrations\"")
  expect(text).toMatch(/DatabaseMigrations\.run\(\[\s*JournalMigrations\.set,\s*Migrations\.set/)
  expect(text).not.toContain("installs this package's tables and nothing else")
  expect(text).toContain("`flows_journal_run_progress`")
  expect(text).toContain("`flows_consensus_leases`")
})

it.each([
  "README.md",
  "quickstart.md",
  "api.md",
  "guides/cancel-a-run.md",
  "guides/claim-and-finish-a-run.md",
  "concepts/fencing.md"
])("%s explains the serialized transaction boundary for owned transitions", (page) => {
  const text = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8").replace(/\s+/g, " ")

  expect(text).toContain("same serialized write transaction")
  expect(text).not.toMatch(/same (?:SQL )?statement as the mutation|compiled into the same `UPDATE`/)
  expect(text).not.toContain("compiled into the transition's own `UPDATE`")
  expect(text).not.toContain("exclusive in SQL")
})

it("documents the current run-store service and migration exports", () => {
  const text = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8").replace(/\s+/g, " ")

  expect(text).toContain("Seventeen operations.")
  expect(text).toContain("const make: Effect<Service, never, Consensus | DurableWriter | SqlClient.SqlClient>")
  expect(text).toContain("const layerWith: Layer<RunStore, never, Consensus | DurableWriter | SqlClient.SqlClient>")
  expect(text).toContain("const revisionTriggers: ReadonlyArray<Dialect.DeferredTrigger>")
  expect(text).toContain("const deferredRevisions: Effect<void, unknown, SqlClient.SqlClient>")
  expect(text).toContain("`deferredRevisions` is not included in `set`")
})

it.each(["concepts/liveness-evidence.md", "guides/recover-a-stalled-run.md"])(
  "%s distinguishes the Node runtime default from the optional PID probe",
  (page) => {
    const text = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8").replace(/\s+/g, " ")

    expect(text).toContain("`isAlive` option is optional")
    expect(text).toContain("`HostLiveness.isAlive({ hostId })`")
    expect(text).toContain("`crossHostPolicy: \"alive\"`")
    expect(text).toContain("`HostLiveness.sameHostPidProbe`")
    expect(text).not.toMatch(/requires (?:an )?`isAlive`|takes no default/)
  }
)
