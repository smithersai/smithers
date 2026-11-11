import { Action, Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as On from "../src/On.ts"
import * as Trigger from "../src/Trigger.ts"

const step = Action.make("gate/step", { payload: {} })
const Gate = Flow.make("gate", { payload: {}, body: () => step.call({}) })

const decodeOn = Schema.decodeUnknownResult(On.On)
const row = (id: string, binding: Trigger.Binding) =>
  Schema.decodeUnknownSync(Trigger.ManifestRow)(Trigger.manifestRow(id, binding))

describe("On", () => {
  it("builds each event as a value its schema accepts", () => {
    const events = [
      On.push(),
      On.push({ branches: ["main"], tags: ["v*"] }),
      On.pullRequest({ branches: ["main"], actions: ["opened"] }),
      On.manual(),
      On.cron("23 3 * * *", { timezone: "UTC", overlap: "skip", catchUp: "one", maxCatchUp: 1 })
    ]
    expect(events.map((event) => decodeOn(event)._tag)).toEqual(["Success", "Success", "Success", "Success", "Success"])
    expect(On.pullRequest()).toEqual({ _tag: "PullRequest" })
    expect(On.cron("0 * * * *")).toEqual({ _tag: "Cron", cron: "0 * * * *" })
  })

  it("refuses a seconds field, an empty glob and more than 32 globs", () => {
    expect(decodeOn(On.cron("0 0 3 * * *"))._tag).toBe("Failure")
    expect(decodeOn(On.push({ branches: [""] }))._tag).toBe("Failure")
    expect(decodeOn(On.push({ branches: Array.from({ length: 33 }, (_, index) => `b${index}`) }))._tag).toBe("Failure")
  })
})

describe("Trigger.bind", () => {
  it("binds an imported flow by its tag", () => {
    const binding = Trigger.bind({ flow: Gate, on: On.push({ branches: ["main"] }) })
    expect(binding).toEqual({ _tag: "TriggerBinding", flow: "gate", on: { _tag: "Push", branches: ["main"] } })
    expect(Schema.is(Trigger.Binding)(binding)).toBe(true)
    expect(Trigger.bind({ flow: Gate, on: On.manual(), title: "Run the gate" }).title).toBe("Run the gate")
  })

  it("projects each event to the manifest row a host matches", () => {
    expect(row("gate-main", Trigger.bind({ flow: Gate, on: On.push({ branches: ["main"] }) }))).toEqual({
      on: "github.push",
      flow: "gate",
      title: "gate-main",
      branches: ["main"]
    })
    expect(row("gate-pr", Trigger.bind({ flow: Gate, on: On.pullRequest({ actions: ["opened"] }) }))).toEqual({
      on: "github.pull_request",
      flow: "gate",
      title: "gate-pr",
      actions: ["opened"]
    })
    expect(row("gate-manual", Trigger.bind({ flow: Gate, on: On.manual(), title: "Run the gate" }))).toEqual({
      on: "manual",
      flow: "gate",
      title: "Run the gate"
    })
    expect(row("nightly", Trigger.bind({ flow: Gate, on: On.cron("23 3 * * *", { overlap: "buffer-one" }) }))).toEqual({
      on: "cron",
      flow: "gate",
      title: "nightly",
      cron: "23 3 * * *",
      overlap: "buffer-one"
    })
  })
})
