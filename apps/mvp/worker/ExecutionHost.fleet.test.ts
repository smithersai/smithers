// The host's shipped registration composes real Admin and fleet flows over Postgres and the durable Node engine.
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Flows from "./Flows.ts"
import * as FleetAlert from "./flows/FleetAlert.ts"
import * as Admin from "./runners/AdminFlows.ts"
import * as Fleet from "./runners/Fleet.ts"
import { runFlow } from "./test/flowHost.ts"
import { testFile } from "./test/harness.ts"

const runtime = testFile("execution_fleet")

test("the host registers and runs Admin writes, runner health and fleet incidents together", async () => {
  const database = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
  const runs = ExecutionHost.withFleet(
    ExecutionHost.withRunners({ flows: [], registration: Layer.empty }, database),
    database, "github/acme/widgets", Fleet.DEFAULTS,
    Effect.succeed(FleetAlert.startWith(Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" })) }))),
  )
  const written = await runFlow(Admin.AddRunner, {
    repoId: "github/acme/widgets", name: "mini", tokenSha256: "a".repeat(64), labels: ["mac"], capacity: 2, actorId: "admin",
  }, runs.registration)
  expect(written.exit).toEqual(Exit.succeed({ change: "set" }))
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT name, capacity FROM runners`)))
    .toEqual([{ name: "mini", capacity: 2 }])
  const health = await runFlow(FleetAlert.RunnerHealth, { from: 0, until: 60_000 }, runs.registration)
  expect(health.exit).toEqual(Exit.succeed({ offline: 0 }))
  const missing = await runFlow(FleetAlert.FleetAlert, {
    alertId: "missing-runner", kind: "offline", repoId: "github/acme/widgets", subject: "gone",
  }, runs.registration)
  expect(missing.exit).toEqual(Exit.succeed({ email: { outcome: "off" }, telegram: { outcome: "off" } }))
  expect(runs.flows.map((flow) => flow._tag)).toContain("admin/AddRunner")
  expect(runs.flows.map((flow) => flow._tag)).toContain("ops/RunnerHealth")
  expect(runs.flows.map((flow) => flow._tag)).toContain("ops/FleetAlert")
})
