import { describe, test } from "vitest"
import * as AlertPolicy from "../src/AlertPolicy.ts"
import type * as Notification from "../src/Notification.ts"
import * as NotificationState from "../src/NotificationState.ts"

const notifications: ReadonlyArray<Notification.Notification> = Array.from({ length: 64 }, (_, i) => ({
  _tag: i % 3 === 0 ? "human-steer" : "human-followup",
  id: `notif-${i}`,
  targetLineageId: "lineage-main",
  delivery: i % 3 === 0 ? "steer" : "queue",
  provenance: {
    sourceRunId: "run-parent",
    sourceLineageId: "lineage-main",
    sourceTurn: i,
    sourceActor: "user:alice"
  },
  payload: { message: `Instruction ${i}`, priority: i % 3 }
}) as Notification.Notification)

const policy: AlertPolicy.Policy = {
  rules: {
    failed: {
      severity: "critical",
      afterMs: 0
    }
  }
}

const detectors = AlertPolicy.detectorsOf(policy)

describe("notifications hot paths", () => {
  test("NotificationState admit + promoteSteers + applyPromoted", async ({ bench }) => {
    await bench("admit 64 notifications + promote steers + apply", () => {
      let state = NotificationState.empty(128)
      for (let i = 0; i < notifications.length; i++) {
        state = NotificationState.admit(state, notifications[i]!, i + 1).state
      }
      const promotion = NotificationState.promoteSteers(state, 64, "lineage-main")
      NotificationState.applyPromoted(
        state,
        promotion.promoted.map((item) => item.notification.id)
      )
    }).run({ time: 120, warmupTime: 30 })
  })

  test("AlertPolicy.coalescingKey + alertId + detectorsOf", async ({ bench }) => {
    await bench("compute 64 alert coalescing keys, ids, and detector maps", () => {
      const merged = AlertPolicy.detectorsOf(policy)
      const count = Object.keys(merged).length + Object.keys(detectors).length
      for (let i = 0; i < 64; i++) {
        const key = AlertPolicy.coalescingKey(`run-${i}`, "failed")
        AlertPolicy.alertId({ coalescingKey: key, since: 1_700_000_000_000 + i + count, reminder: 0 })
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
