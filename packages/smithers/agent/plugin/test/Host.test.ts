import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Host from "../src/Host.ts"

describe("PluginRefused", () => {
  it("is a tagged error a host fails with and a caller can match", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        new Host.PluginRefused({ plugin: "queue", reason: "person_only", detail: "run/answer is person-only" })
      )
    )
    expect(error).toBeInstanceOf(Host.PluginRefused)
    expect(error).toMatchObject({ _tag: "plugin/PluginRefused", plugin: "queue", reason: "person_only" })
  })

  it("admits exactly the closed reasons", () => {
    const decode = Schema.decodeUnknownSync(Host.RefusedReason)
    for (
      const reason of [
        "person_only",
        "undeclared_query",
        "undeclared_event",
        "not_in_reads",
        "invalid_fields",
        "unknown_view",
        "no_item",
        "outside_ceiling"
      ]
    ) expect(decode(reason)).toBe(reason)
    expect(() => decode("forbidden")).toThrow()
  })
})

describe("PluginHost", () => {
  it("is the service key a tab layer requires", () => {
    expect(Host.PluginHost.key).toBe("@smthrs/plugin/PluginHost")
  })
})

describe("Settled", () => {
  it("is Done, or Failed with a code, and nothing else", () => {
    const decode = Schema.decodeUnknownSync(Host.Settled)
    expect(decode({ _tag: "Done" })).toEqual({ _tag: "Done" })
    expect(decode({ _tag: "Failed", code: "authentication" })).toEqual({ _tag: "Failed", code: "authentication" })
    expect(() => decode({ _tag: "Failed" })).toThrow()
    expect(() => decode({ _tag: "Running" })).toThrow()
  })
})

describe("query parameters", () => {
  it("reach the host's query, and an item names the ones its query was asked with", async () => {
    const asked: Array<[string, Host.QueryParams | undefined]> = []
    const rows = [{ id: "acme/widgets:lanes" }]
    const host: Pick<Host.PluginHost, "query"> = {
      query: <R>(name: string, params?: Host.QueryParams) =>
        Effect.sync(() => {
          asked.push([name, params])
          return { current: () => rows as unknown as ReadonlyArray<R>, subscribe: () => () => {} }
        })
    }
    const live = await Effect.runPromise(host.query<{ readonly id: string }>("core/feeds", { repo: "acme/widgets" }))
    await Effect.runPromise(host.query("core/waits"))
    const item: Host.ItemRef = { query: "core/feeds", key: live.current()[0]!.id, params: { repo: "acme/widgets" } }
    expect(asked).toEqual([["core/feeds", { repo: "acme/widgets" }], ["core/waits", undefined]])
    expect(item).toEqual({ query: "core/feeds", key: "acme/widgets:lanes", params: { repo: "acme/widgets" } })
  })
})
