import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { describeEvent, describeSchedule } from "./TriggerEvents"
import { TriggerListCardBody } from "./TriggersCard"

/*
 * The dispatcher card (factory mock 2): declared rows say their event in
 * words and the flow they start under the "declared in .smithers/FACTORY.ts"
 * pill; live columns exist only when a box answered; a signed-out card has
 * no live column and no placeholder for one; with nothing declared and no
 * box the card is exactly one sentence; and Register is the button door of
 * triggers.register carrying the repository.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
type Payload = TriggerListCard["payload"]

const triggerCard = (payload: Partial<Payload>): TriggerListCard => ({
  id: `trigger-list-${REPO}`,
  kind: "trigger-list",
  title: `Dispatcher · ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, triggers: [], webhooks: [], ...payload }
})

/** The day-one table of design §7, as the projection carries it. */
const DECLARED: NonNullable<Payload["declared"]> = [
  { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
  { event: "issue.labeled:smithers", flow: "implement" },
  { event: "change.landed", flow: ["wiki", "history.fold", "improve.mine"] },
  { event: "github.push:main", flow: "history.fold" },
  { event: "schedule:0 9 * * 1-5", flow: "review", description: "Weekday morning review of main" }
]

const render = (card: TriggerListCard, onRunCommand: (name: string, args?: string) => void = () => {}): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<TriggerListCardBody card={card} onRunCommand={onRunCommand} />)
  })
  return host
}

describe("the event a trigger waits for, in words", () => {
  test("names the common schedules and prints the zone only when the trigger declared one", () => {
    expect(describeSchedule("0 9 * * 1-5", "UTC")).toBe("Every weekday at 09:00 UTC")
    expect(describeSchedule("30 17 * * *")).toBe("Every day at 17:30")
    expect(describeSchedule("0 8 * * 1,3,5", "Europe/London")).toBe("Every Monday, Wednesday, Friday at 08:00 Europe/London")
    expect(describeSchedule("0 0 * * 0")).toBe("Every Sunday at 00:00")
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeSchedule("0 * * * *")).toBe("Every hour")
    expect(describeSchedule("0 */6 * * *")).toBe("Every 6 hours")
    expect(describeSchedule("30 */6 * * *")).toBe("Every 6 hours at 30 minutes past")
    expect(describeSchedule("15 */2 * * *")).toBe("Every 2 hours at 15 minutes past")
    expect(describeSchedule("* * * * *")).toBe("Every minute")
    expect(describeSchedule("0 6 1 * *", "UTC")).toBe("Monthly on day 1 at 06:00 UTC")
  })

  test("a schedule the shorthand cannot say is shown as its expression", () => {
    expect(describeSchedule("0 9 * 1-6 1-5")).toBe("On the schedule 0 9 * 1-6 1-5")
    expect(describeSchedule("5 4 * * sun", "UTC")).toBe("On the schedule 5 4 * * sun UTC")
    expect(describeSchedule("not a cron")).toBe("On the schedule not a cron")
  })
})

describe("the event a declared rule waits for, in words", () => {
  test("says every key of the vocabulary and its parameterized families", () => {
    expect(describeEvent("issue.opened")).toBe("On a new issue")
    expect(describeEvent("issue.labeled:smithers")).toBe("On an issue labeled smithers")
    expect(describeEvent("issue.closed")).toBe("On an issue closed")
    expect(describeEvent("change.opened")).toBe("On a Change opened")
    expect(describeEvent("change.updated")).toBe("On a Change updated")
    expect(describeEvent("change.landed")).toBe("On a Change landed")
    expect(describeEvent("box.session.ended")).toBe("On a box session ended")
    expect(describeEvent("github.push:main")).toBe("GitHub push on main")
    expect(describeEvent("schedule:0 9 * * 1-5")).toBe("Every weekday at 09:00")
    expect(describeEvent("schedule:*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeEvent("schedule:0 10 * * 1")).toBe("Every Monday at 10:00")
    expect(describeEvent("nomination")).toBe("On a nomination")
    expect(describeEvent("manual")).toBe("Started by hand")
  })

  test("a key the vocabulary does not know is printed as itself, never guessed at", () => {
    expect(describeEvent("release.tagged")).toBe("release.tagged")
    expect(describeEvent("schedule:")).toBe("schedule:")
    expect(describeEvent("  issue.opened ")).toBe("On a new issue")
  })
})

describe("the dispatcher card", () => {
  test("declared rows render in words with the flow they start, under the declared-in pill", () => {
    const host = render(triggerCard({ declared: DECLARED, live: false }))
    expect(host.querySelector("[data-testid='trigger-declared-pill']")?.textContent).toBe("declared in .smithers/FACTORY.ts")
    const rows = [...host.querySelectorAll("[data-source='declared']")]
    expect(rows.map((row) => row.getAttribute("data-rule"))).toEqual([
      "issue.opened",
      "issue.labeled:smithers",
      "change.landed",
      "github.push:main",
      "schedule:0 9 * * 1-5"
    ])
    /* A description is the sentence with the flow beside it; without one the row says what runs. */
    expect(rows[0]?.textContent).toBe("On a new issueTriage every new issue (issue)")
    expect(rows[1]?.textContent).toBe("On an issue labeled smithersruns implement")
    expect(rows[2]?.textContent).toBe("On a Change landedruns wiki, history.fold, improve.mine")
    expect(rows[3]?.textContent).toBe("GitHub push on mainruns history.fold")
    expect(rows[4]?.textContent).toBe("Every weekday at 09:00Weekday morning review of main (review)")
    expect(host.querySelector("[data-testid='trigger-list-empty']")).toBeNull()
  })

  test("signed out there is no live column and no placeholder for one", () => {
    const host = render(triggerCard({ declared: DECLARED, live: false }))
    expect(host.querySelector("[data-testid='trigger-live']")).toBeNull()
    expect(host.querySelector("[data-source='box']")).toBeNull()
    expect(host.querySelector("[data-trigger]")).toBeNull()
    expect(host.querySelector("[data-webhook]")).toBeNull()
    expect(host.textContent).not.toMatch(/listening|heartbeat|enabled|disabled|fired|next |running/)
    /* Live rows persisted on an older card still stay out of a card whose box did not answer this time. */
    const stale = render(
      triggerCard({
        declared: DECLARED,
        live: false,
        triggers: [{ id: "nightly", flowId: "review", cron: "0 9 * * 1-5", enabled: true }],
        webhooks: [{ name: "github" }]
      })
    )
    expect(stale.querySelector("[data-source='box']")).toBeNull()
    expect(stale.textContent).not.toMatch(/enabled|fired|Webhook/)
  })

  test("a box that answered adds the live columns: listening, state, last fired, next fire, the run in flight, and the webhooks", () => {
    const host = render(
      triggerCard({
        declared: DECLARED.slice(0, 1),
        live: true,
        triggers: [
          {
            id: "nightly",
            flowId: "review",
            cron: "0 9 * * 1-5",
            timezone: "UTC",
            enabled: true,
            lastFiredAt: Date.now() - 60_000,
            nextFireAt: Date.now() + 3_600_000,
            activeRunId: "run-8f21"
          },
          { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
        ],
        webhooks: [{ name: "github-push", flowId: "review" }, { name: "linear" }]
      })
    )
    expect(host.querySelector("[data-testid='trigger-live']")?.textContent).toBe("listening")
    /* Declared rows first, then the box's. */
    expect([...host.querySelectorAll("[data-source]")].map((row) => row.getAttribute("data-source"))).toEqual([
      "declared",
      "box",
      "box",
      "box",
      "box"
    ])
    const nightly = host.querySelector("[data-trigger='nightly']")
    expect(nightly?.textContent).toContain("Every weekday at 09:00 UTC")
    expect(nightly?.textContent).toContain("runs review")
    expect(host.querySelector("[data-testid='trigger-state-nightly']")?.textContent).toMatch(
      /^enabled · last fired .+ · next .+ · running run-8f21$/
    )
    expect(host.querySelector("[data-testid='trigger-state-sweep']")?.textContent).toBe("disabled · never fired")
    const webhooks = [...host.querySelectorAll("[data-webhook]")]
    expect(webhooks.map((row) => row.getAttribute("data-webhook"))).toEqual(["github-push", "linear"])
    expect(webhooks[0]?.textContent).toBe("Webhook github-pushruns review")
    expect(webhooks[1]?.textContent).toBe("Webhook linear")
  })

  test("with nothing declared and no box answering, the card is exactly one sentence", () => {
    const host = render(triggerCard({ declared: [], live: false }))
    expect(host.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    expect(host.querySelector("[data-testid='trigger-list']")).toBeNull()
    expect(host.querySelector("[data-testid='trigger-declared-pill']")).toBeNull()
    expect(host.textContent).not.toContain("trigger store")
    /* A card persisted before the declaration joined the listing carries neither field and still renders the sentence. */
    const legacy = render(triggerCard({}))
    expect(legacy.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    /* A listening box with nothing registered and nothing declared: still the sentence, beside the fact that it listens. */
    const listening = render(triggerCard({ declared: [], live: true }))
    expect(listening.querySelector("[data-testid='trigger-list-empty']")?.textContent).toBe("No rules declared yet")
    expect(listening.querySelector("[data-testid='trigger-live']")?.textContent).toBe("listening")
  })

  test("Register is the button door of triggers.register and carries the repository", () => {
    const calls: Array<[string, string | undefined]> = []
    const host = render(triggerCard({ declared: DECLARED, live: false }), (name, args) => calls.push([name, args]))
    const button = host.querySelector<HTMLButtonElement>("[data-testid='trigger-register']")
    expect(button?.dataset.flow).toBe("triggers.register")
    expect(button?.textContent).toBe("Register a rule")
    button?.click()
    expect(calls).toEqual([["triggers.register", REPO]])
    /* The one button: nothing in the card removes or edits a declared rule. */
    expect(host.querySelectorAll("button")).toHaveLength(1)
  })
})
