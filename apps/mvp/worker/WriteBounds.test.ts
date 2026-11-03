import { Deferred, Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import * as WorkLinks from "./github/WorkLinks.ts"
import * as Stack from "./stack/Stack.ts"
import * as Runners from "./runners/Store.ts"

const runtime = testFile("write_bounds")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))
beforeAll(async () => {
  await sql(`CREATE FUNCTION assert_write_bounds() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('lock_timeout')::interval <> interval '1 second'
      OR current_setting('statement_timeout')::interval <> interval '2 seconds'
      OR current_setting('transaction_timeout')::interval <> interval '5 seconds' THEN
      RAISE EXCEPTION 'unbounded write: lock=%, statement=%, transaction=%',
        current_setting('lock_timeout'), current_setting('statement_timeout'), current_setting('transaction_timeout');
    END IF;
    RETURN NEW;
  END $$`)
  for (const table of ["work_links", "stacks", "runner_changes"]) {
    await sql(`CREATE TRIGGER write_bounds BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION assert_write_bounds()`)
  }
})
test("WorkLinks installs bounds before its first write", async () => {
  const result = await runtime.runPromise(WorkLinks.write("github/acme/test", 1,
    { links: [{ kind: "queue", ref: "bounded" }] }, "person", Date.now()))
  expect(result._tag).toBe("Some")
})
test("Stack installs bounds before creating or locking its row", async () => {
  const result = await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: "github/acme/test",
    actor: { id: "person", login: "person" }, via: "person", op: { kind: "configure", lanes: 1, maxOpen: 50, base: "stacked" } }, { runs: false }))
  expect(result.kind).toBe("applied")
})
test("runner writes install bounds before taking any resource lock", async () => {
  expect(await runtime.runPromise(Runners.addRunner({ repoId: "github/acme/test", name: "bounded", tokenSha256: "b".repeat(64),
    labels: [], capacity: 1, repoAuthorized: true }, { actorId: "person", invocationKey: "bounded" }))).toBe("set")
})

// Exercise the actual wait, not only the installed settings. No sleeps: a second real transaction owns the lock
// until the writer has failed. Baseline without bounds times out at the test deadline.
test.each(["links", "stack", "runner"] as const)("%s ends an actual blocked write within its lock timeout", async (path) => {
  const locked = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const holder = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(Effect.gen(function* () {
    if (path === "runner") yield* client`SELECT pg_advisory_xact_lock(hashtextextended('runners:github/acme/blocked:blocked', 0))`
    else yield* client.unsafe(`LOCK TABLE ${path === "links" ? "work_links" : "stacks"} IN ACCESS EXCLUSIVE MODE`)
    yield* Deferred.succeed(locked, undefined)
    yield* Deferred.await(release)
  }))))
  await Effect.runPromise(Deferred.await(locked))
  try {
    const started = performance.now()
    const write: Effect.Effect<unknown, unknown, SqlClient.SqlClient> = path === "links" ? WorkLinks.write("github/acme/blocked", 1, { links: [{ kind: "queue", ref: "blocked" }] }, "person", Date.now())
      : path === "stack" ? Stack.apply({ opId: crypto.randomUUID(), repoId: "github/acme/blocked", actor: { id: "person", login: "person" },
        via: "person", op: { kind: "configure", lanes: 1, maxOpen: 50, base: "stacked" } }, { runs: false })
      : Runners.addRunner({ repoId: "github/acme/blocked", name: "blocked", tokenSha256: "d".repeat(64), labels: [], capacity: 1,
        repoAuthorized: true }, { actorId: "person", invocationKey: "blocked" })
    const result = await runtime.runPromise(Effect.exit(write.pipe(Effect.timeoutOrElse({ duration: "2500 millis", orElse: () => Effect.succeed("unbounded" as const) }))))
    const elapsed = Math.round(performance.now() - started)
    console.info("write.lock_timeout", { path, elapsed })
    expect(Exit.isFailure(result)).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(Exit.isFailure(result) ? String(result.cause) : "unbounded").toContain("lock timeout")
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await holder
  }
})
