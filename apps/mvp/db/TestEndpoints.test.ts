import { ConfigProvider, Effect } from "effect"
import { expect, test } from "vitest"
import * as TestDatabase from "./TestDatabase.ts"

const configured = <A, E>(effect: Effect.Effect<A, E>, values: Record<string, string>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))))

test("an explicit localhost test port isolates the database without allowing another host or port", async () => {
  const values = { TEST_DATABASE_PORT: "55441", DATABASE_URL: "postgresql://smithers:smithers@localhost:55441/smithers" }
  expect((await configured(TestDatabase.serverUrl, values)).port).toBe("55441")
  for (const database of ["postgresql://owner:PRIVATE@db.example.com:55441/prod", "postgresql://owner:PRIVATE@localhost:54321/prod"]) {
    const failure = await configured(Effect.flip(TestDatabase.serverUrl), { ...values, DATABASE_URL: database })
    expect(failure).toBeInstanceOf(TestDatabase.Unusable)
    expect(String(failure)).not.toContain("PRIVATE")
  }
})

test("an isolated Electric endpoint stays on localhost", async () => {
  expect(await configured(TestDatabase.electricUrl, { TEST_ELECTRIC_PORT: "30441" })).toBe("http://localhost:30441")
  expect(await configured(TestDatabase.electricUrl, {})).toBe("http://localhost:30001")
})


test("nested fixture configuration retains selected database and Electric endpoints only", async () => {
  const values = {
    TEST_DATABASE_PORT: "55441", TEST_ELECTRIC_PORT: "30441",
    DATABASE_URL: "postgresql://smithers:smithers@localhost:55441/smithers", PRIVATE_TOKEN: "must-not-inherit",
  }
  const selected = await configured(TestDatabase.fixtureConfig, values)
  expect(selected).toEqual({
    DATABASE_URL: values.DATABASE_URL, TEST_DATABASE_PORT: "55441",
    ELECTRIC_URL: "http://localhost:30441", TEST_ELECTRIC_PORT: "30441",
  })
  expect((await configured(TestDatabase.serverUrl, selected)).port).toBe("55441")
  expect(await configured(TestDatabase.electricUrl, selected)).toBe("http://localhost:30441")
})

for (const port of ["54321", "55582"]) {
  test.each(["localhost", "127.0.0.1", "[::1]"])(`the isolated local database accepts %s at port ${port}`, async host => {
    const values = {
      ...(port === "54321" ? {} : { TEST_DATABASE_PORT: port }),
      DATABASE_URL: `postgresql://owner:PRIVATE@${host}:${port}/fixture`,
    }
    expect((await configured(TestDatabase.serverUrl, values)).host).toBe(`${host}:${port}`)
  })
}

test.each([
  "postgresql://owner:PRIVATE@db.example.com:55582/fixture",
  "postgresql://owner:PRIVATE@127.0.0.2:55582/fixture",
  "postgresql://owner:PRIVATE@127.0.0.1:54321/fixture",
  "postgresql://owner:PRIVATE@[::1]:54321/fixture",
  "postgresql://owner:PRIVATE@localhost/fixture",
])("the isolated local database refuses a different endpoint without credentials: %s", async database => {
  const failure = await configured(Effect.flip(TestDatabase.serverUrl), { TEST_DATABASE_PORT: "55582", DATABASE_URL: database })
  expect(failure).toBeInstanceOf(TestDatabase.Unusable)
  expect(String(failure)).not.toContain("PRIVATE")
  expect(String(failure)).not.toContain("owner")
})

test.each([
  "host=remote-PRIVATE.example", "host=localhost", "host=", "port=55582", "port=5432", "port=",
  "host=localhost&host=remote-PRIVATE.example", "host=remote-PRIVATE.example&host=localhost",
  "port=55582&port=5432", "port=5432&port=55582", "%68ost=remote-PRIVATE.example", "%70ort=5432",
])("the isolated local database refuses every host or port query override: %s", async query => {
  const failure = await configured(Effect.flip(TestDatabase.serverUrl), {
    TEST_DATABASE_PORT: "55582", DATABASE_URL: `postgresql://owner:PRIVATE@localhost:55582/fixture?${query}`,
  })
  expect(failure).toBeInstanceOf(TestDatabase.Unusable)
  expect(String(failure)).not.toContain("PRIVATE")
  expect(String(failure)).not.toContain("owner")
  expect(String(failure)).not.toContain(query)
})

// In a combined unit/e2e farm command, SQL uses the slot database. Shapes must use that slot's Electric too.
test("the running farm selects the same Electric port for app and test fixtures", async () => {
  const url = new URL(await Effect.runPromise(TestDatabase.electricUrl))
  const expected = process.env.FARM_ELECTRIC_PORT ?? process.env.TEST_ELECTRIC_PORT ?? "30001"
  expect(url.port).toBe(expected)
  if (process.env.FARM_ELECTRIC_PORT !== undefined) {
    expect(new URL(process.env.ELECTRIC_URL!).port).toBe(expected)
    expect((await Effect.runPromise(TestDatabase.serverUrl)).pathname).toBe(`/smithers_farm_slot${process.env.FARM_SLOT}`)
  }
})
