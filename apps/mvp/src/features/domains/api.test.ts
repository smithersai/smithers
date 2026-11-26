// `DomainsClient` against every answer ChatApi's domain routes give (worker/domains/Api.ts), through the host's `fetch`:
// the browser's own capability, given here as a function answering the request it is handed. The steps that call it
// (`domain/add/request`, `domain/remove/request`) are driven over a client that answers as told. The words the page
// shows for each state, problem and refusal are checked here too.
import { Cause, Effect, Exit, Layer, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { mayManageDomains } from "../auth/contract"
import { DomainNotTaken, DomainsClient } from "./api.vibe"
import { REFUSALS } from "./contract"
import { problemText, refusalText } from "./copy"
import { DomainRefused, DomainUnsent } from "./flows"
import { failureOf, requestAdd, requestRemove, requests } from "./steps.vibe"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = DomainsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: DomainsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(DomainsClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as DomainNotTaken) } : "succeeded"

const json = (body: unknown, status = 202) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const vibelang = { owner: "smithersai", name: "vibelang", hostname: "vibelang.sh" } as const

describe("DomainsClient", () => {
  test("adds at POST <repo>/domains and removes at DELETE <repo>/domains/<hostname>, taking a 202", async () => {
    const { run, seen } = client(() => json({ hostname: "vibelang.sh" }))
    expect(await run((c) => c.add(vibelang))).toEqual(Exit.succeed({ hostname: "vibelang.sh" }))
    expect(await run((c) => c.remove(vibelang))).toEqual(Exit.succeed({ hostname: "vibelang.sh" }))
    expect(seen).toEqual([
      {
        method: "POST",
        url: "http://chat.test/api/repos/smithersai/vibelang/domains",
        body: `{"hostname":"vibelang.sh"}`,
      },
      { method: "DELETE", url: "http://chat.test/api/repos/smithersai/vibelang/domains/vibelang.sh", body: "" },
    ])
  })

  test("malformed route segments fail during request construction", async () => {
    const { run, seen } = client(() => json({ hostname: "vibelang.sh" }))
    const exit = await run((c) => Effect.sync(() => {
      expect(() => c.add({ ...vibelang, owner: "\ud800" })).toThrow(URIError)
      expect(() => c.remove({ ...vibelang, hostname: "\ud800" })).toThrow(URIError)
    }))
    expect(exit).toEqual(Exit.succeed(undefined))
    expect(seen).toEqual([])
  })

  test("a refusal carries its status and the route's code, or its status alone without one", async () => {
    expect(refusalOf(await client(() => json({ code: "forbidden" }, 403)).run((c) => c.add(vibelang)))).toEqual({
      _tag: "DomainNotTaken",
      status: 403,
      code: "forbidden",
    })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.remove(vibelang))))
      .toEqual({ _tag: "DomainNotTaken", status: 503 })
    // A 200 isn't the route's answer: it answers 202 once its flow started.
    expect(refusalOf(await client(() => json({ hostname: "vibelang.sh" }, 200)).run((c) => c.add(vibelang)))).toEqual({
      _tag: "DomainNotTaken",
      status: 200,
    })
  })

  test("no network, a body that isn't the route's, and no answer within the deadline are refusals", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.add(vibelang)))).toEqual({
      _tag: "DomainNotTaken",
    })
    expect(refusalOf(await client(() => json({ host: 1 })).run((c) => c.add(vibelang)))).toEqual({
      _tag: "DomainNotTaken",
      status: 202,
    })
    const never = client(() => new Promise<Response>(() => {}), "50 millis")
    expect(refusalOf(await never.run((c) => c.add(vibelang)))).toEqual({ _tag: "DomainNotTaken" })
  })
})

describe("failureOf", () => {
  test("a 4xx is final, with its code when it is one of the route's; anything else is tried again", () => {
    expect(failureOf(new DomainNotTaken({ status: 409, code: "taken" }))).toEqual(
      new DomainRefused({ status: 409, code: "taken" }),
    )
    expect(failureOf(new DomainNotTaken({ status: 400, code: "made_up" }))).toEqual(new DomainRefused({ status: 400 }))
    expect(failureOf(new DomainNotTaken({ status: 404 }))).toEqual(new DomainRefused({ status: 404 }))
    expect(failureOf(new DomainNotTaken({ status: 503, code: "unavailable" }))).toEqual(new DomainUnsent())
    expect(failureOf(new DomainNotTaken({ status: 503, code: "off" }))).toEqual(new DomainRefused({ status: 503, code: "off" }))
    expect(failureOf(new DomainNotTaken({ status: 399 }))).toEqual(new DomainUnsent())
    expect(failureOf(new DomainNotTaken({}))).toEqual(new DomainUnsent())
  })
})

describe("domain/add/request and domain/remove/request", () => {
  /** A step over a client answering `answer`, with its counts by outcome. */
  const step = (which: "add" | "remove", answer: Effect.Effect<{ readonly hostname: string }, DomainNotTaken>) => {
    const registry: Metric.MetricRegistry = new Map()
    const run = which === "add" ? requestAdd : requestRemove
    return Effect.runPromise(
      Effect.exit(run(vibelang)).pipe(
        Effect.provide(Layer.succeed(DomainsClient, DomainsClient.of({ add: () => answer, remove: () => answer }))),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.flatMap((exit) =>
          Effect.map(
            Effect.all(
              ["sent", "refused", "unsent"].map((outcome) =>
                Effect.map(
                  Metric.value(Metric.withAttributes(requests, { op: which, outcome })),
                  (state) => [outcome, state.count] as const,
                )
              ),
            ),
            (counts) => ({ exit, counts: Object.fromEntries(counts) }),
          ).pipe(Effect.provideService(Metric.MetricRegistry, registry))
        ),
      ),
    )
  }

  test("a write ChatApi took succeeds with its hostname and counts as sent", async () => {
    const { exit, counts } = await step("add", Effect.succeed({ hostname: "vibelang.sh" }))
    expect(exit).toEqual(Exit.succeed({ hostname: "vibelang.sh" }))
    expect(counts).toEqual({ sent: 1, refused: 0, unsent: 0 })
  })

  test("a refusal fails for good, and an unreachable ChatApi fails to be tried again", async () => {
    const refused = await step("remove", Effect.fail(new DomainNotTaken({ status: 403, code: "person_only" })))
    expect(refused.exit).toEqual(Exit.fail(new DomainRefused({ status: 403, code: "person_only" })))
    expect(refused.counts).toEqual({ sent: 0, refused: 1, unsent: 0 })
    const unsent = await step("add", Effect.fail(new DomainNotTaken({})))
    expect(unsent.exit).toEqual(Exit.fail(new DomainUnsent()))
    expect(unsent.counts).toEqual({ sent: 0, refused: 0, unsent: 1 })
  })
})

describe("the page's words", () => {
  test("every problem reads in product words; a provider's own reason reads as it gave it", () => {
    expect(problemText(null)).toBeNull()
    expect(problemText("taken")).toBe("Another account uses this domain")
    expect(problemText("blocked")).toBe("The provider blocked this domain")
    expect(problemText("timed_out")).toBe("DNS records not found. Refresh after adding them")
    expect(problemText("unreachable")).toBe("Couldn't check. Retrying")
    expect(problemText("custom hostname does not CNAME to this zone.")).toBe("custom hostname does not CNAME to this zone.")
  })

  test("every refusal the route answers reads in product words, never as its code", () => {
    for (const code of [...REFUSALS, null]) {
      const text = refusalText(code)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toContain("_")
    }
    expect(refusalText("invalid_hostname")).toBe("Not a valid domain")
    expect(refusalText("taken")).toBe("Another repository uses this domain")
    expect(refusalText("person_only")).toBe("Only Maintainers can change domains")
    expect(refusalText(null)).toBe("Couldn't save. Try again")
  })

  test("only a Maintainer or Admin manages domains", () => {
    expect(["admin", "maintainer", "member", "guest", null].map((role) => mayManageDomains(role as never))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })
})
