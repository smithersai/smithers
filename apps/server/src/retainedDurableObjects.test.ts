import { expect, test } from "bun:test"
import * as retained from "./retainedDurableObjects"
import { WORKER_IDENTITY } from "./workerIdentity"

test("retained namespaces have no state access, job launch or deletion; alarms are refused, never acknowledged", async () => {
  const classes = Object.keys(retained).sort()
  expect(classes).toEqual(WORKER_IDENTITY.durableObjects.map(value => value.className).sort())
  for (const constructor of Object.values(retained)) {
    const instance = new constructor()
    const response = await instance.fetch()
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({ status: "error", code: "authority_retired" })
    // Without storage there is nothing to mark; the alarm is still refused so the platform keeps it.
    await expect(instance.alarm()).rejects.toThrow("authority_retired")
  }
})
