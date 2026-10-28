import { describe, expect, test } from "vitest"
import { accessControlURL, DocumentRequests, nativeAccessControlURL } from "./cancellations"

const origin = "https://smithers.example"
const url = `${origin}/api/shapes/messages?offset=-1`
const asset = `${origin}/engine.worker.js`
const observed = (history: DocumentRequests, identity: string, at: number) =>
  history.observeDocument(history.documentEvent(at), identity)
const make = () => {
  const history = new DocumentRequests()
  observed(history, "A", 0)
  history.start(1, asset, 1)
  return history
}
const classify = (history: DocumentRequests, address: string, at: number) => history.candidate(address, at)?.() ?? false

describe("native access-control addresses", () => {
  test("recognises the console and shortened pageerror address, preserving exact query values internally", () => {
    for (const address of [`Fetch API cannot load ${url}`, "/smithers.example/api/shapes/messages?offset=-1", url]) {
      expect(accessControlURL(origin, `${address} due to access control checks.`)).toBe(url)
    }
  })
  test("does not classify unrelated errors, other origins, assets, credentials or malformed addresses", () => {
    for (const text of ["Load failed", "Fetch API cannot load", "broken due to access control checks.",
      "https://another.example/api/a due to access control checks.", `${origin}/asset.js due to access control checks.`,
      "https://user:password@smithers.example/api/a due to access control checks.",
      "https://:password@smithers.example/api/a due to access control checks."]) expect(accessControlURL(origin, text)).toBeUndefined()
  })
})

describe("native diagnostic delivery", () => {
  const text = `Fetch API cannot load ${url} due to access control checks.`
  test("accepts only WebKit's exact pageerror name or full console diagnostic", () => {
    expect(nativeAccessControlURL(origin, "webkit", { kind: "page", name: "Fetch API cannot load https", text: `/smithers.example/api/shapes/messages?offset=-1 due to access control checks.` })).toBe(url)
    expect(nativeAccessControlURL(origin, "webkit", { kind: "console", text, url: undefined })).toBe(url)
    expect(nativeAccessControlURL(origin, "webkit", { kind: "page", name: "TypeError", text })).toBeUndefined()
    expect(nativeAccessControlURL(origin, "webkit", { kind: "console", text: "Network error", url: undefined })).toBeUndefined()
    expect(nativeAccessControlURL(origin, "webkit", { kind: "console", text: "Fetch API cannot load https://another.example/api/a due to access control checks.", url: undefined })).toBeUndefined()
    expect(nativeAccessControlURL(origin, "webkit", { kind: "failed", method: "GET", url, error: "cancelled" })).toBeUndefined()
    for (const browser of ["chromium", undefined]) expect(nativeAccessControlURL(origin, browser, { kind: "console", text, url: undefined })).toBeUndefined()
  })
})

describe("document cancellation witnesses", () => {
  test("requires an actual cancellation inside a bounded, uncommitted navigation", () => {
    const history = make()
    history.start(2, url, 1)
    expect(history.progress()).toEqual({ navigationAt: undefined, cancelledOldDocument: false })
    expect(history.witness(url, 2)).toEqual({ state: "pending", previousDocument: false, status: undefined, afterNavigationMs: undefined, completedBeforeNavigation: false })
    expect(classify(history, url, 2)).toBe(false)
    history.navigate(100, 10)
    expect(classify(history, url, 11)).toBe(false)
    history.fail(2, "cancelled", 10)
    expect(history.progress()).toEqual({ navigationAt: 10, cancelledOldDocument: true })
    expect(classify(history, url, 10)).toBe(true)
    expect(classify(history, url, 2010)).toBe(true)
    expect(classify(history, url, 2011)).toBe(false)
    expect(classify(history, url, 9)).toBe(false)
    expect(history.witness(url, 0)).toBeUndefined()
    observed(history, "B", 12)
    expect(history.witness(url, 13)?.previousDocument).toBe(true)
    expect(classify(history, url, 13)).toBe(false)
    history.navigate(101, 20)
    expect(classify(history, url, 21)).toBe(false)
  })
  test("allows a pre-dispatch refusal but retains dispatched pending and finished reads", () => {
    const history = make()
    history.navigate(100, 10)
    history.fail(1, "cancelled", 10)
    expect(classify(history, url, 11)).toBe(true)
    history.start(2, url, 12)
    expect(classify(history, url, 13)).toBe(false)
    history.finish(2, 13)
    expect(history.witness(url, 13)?.state).toBe("finished")
    expect(classify(history, url, 13)).toBe(false)
    expect(history.witness(`${url}&live=true`, 13)).toBeUndefined()
  })
  test("successful exports completed before departure cannot stand in for a later pre-dispatch fetch", () => {
    const history = make()
    history.start(2, url, 1)
    history.response(2, 200)
    history.finish(2, 9)
    expect(history.witness(url, 9)?.completedBeforeNavigation).toBe(false)
    history.navigate(100, 10)
    history.fail(1, "cancelled", 10)
    const candidate = history.candidate(url, 11)!
    expect(candidate()).toBe(true)
    expect(history.witness(url, 11)?.completedBeforeNavigation).toBe(true)
    observed(history, "B", 12)
    expect(candidate()).toBe(true)
    // A later refusal for that request revokes classification, including after commit.
    history.response(2, 403)
    expect(candidate()).toBe(false)
  })
  test("completion at or after departure, unknown documents and prior refusals remain errors", () => {
    for (const finishedAt of [9, 10, 11]) for (const status of [undefined, 200, 403, 500]) {
      const history = make()
      history.start(2, url, 1)
      if (status !== undefined) history.response(2, status)
      history.finish(2, finishedAt)
      history.navigate(100, 10)
      history.fail(1, "cancelled", 10)
      expect(classify(history, url, 12)).toBe(finishedAt < 10 && status === 200)
    }
  })
  test("bounds WebKit's cancellation-before-navigation ordering to 100 ms", () => {
    for (const delay of [0, 100, 101]) {
      const history = make()
      history.fail(1, "cancelled", 10)
      history.navigate(100, 10 + delay)
      expect(classify(history, url, 11 + delay)).toBe(delay <= 100)
    }
  })
  test("retains HTTP refusals and real transport failures", () => {
    for (const status of [200, 399, 400, 403, 500]) {
      const history = make()
      history.start(2, url, 1)
      history.response(2, status)
      history.navigate(100, 10)
      history.fail(1, "cancelled", 10)
      history.fail(2, "cancelled", 10)
      expect(classify(history, url, 11)).toBe(status < 400)
      history.finish(2, 13)
      expect(classify(history, url, 12)).toBe(false)
    }
    for (const error of ["cancelled", "net::ERR_ABORTED", "NS_BINDING_ABORTED", "net::ERR_CONNECTION_RESET", "Blocked by access control"]) {
      const history = make()
      history.start(2, url, 1)
      history.navigate(100, 10)
      history.fail(1, "cancelled", 10)
      history.fail(2, error, 10)
      expect(classify(history, url, 11)).toBe(!error.includes("RESET") && error !== "Blocked by access control")
    }
  })
  test("late and concurrent refusals revoke a captured candidate after commit", () => {
    const history = make()
    history.start(2, url, 1)
    history.start(3, url, 2)
    history.navigate(100, 10)
    history.fail(1, "cancelled", 10)
    const candidate = history.candidate(url, 11)!
    expect(candidate()).toBe(false)
    history.fail(2, "cancelled", 11)
    history.fail(3, "cancelled", 11)
    expect(candidate()).toBe(true)
    observed(history, "B", 12)
    expect(candidate()).toBe(true)
    history.response(2, 403)
    expect(candidate()).toBe(false)
    history.finish(2, 13)
    history.start(4, url, 20)
    expect(candidate()).toBe(false)
  })
  test("redirects retain the outgoing document and every matching outcome", () => {
    for (const outcome of ["pending", "finished", "failed", "refused"]) {
      const history = make()
      history.start(2, url, 1)
      history.navigate(100, 10)
      history.navigate(101, 12, 100)
      history.fail(1, "cancelled", 13)
      if (outcome === "finished") history.finish(2, 13)
      if (outcome === "failed") history.fail(2, "reset", 13)
      if (outcome === "refused") { history.response(2, 403); history.fail(2, "cancelled", 13) }
      expect(classify(history, url, 14)).toBe(false)
    }
  })
  test("pushState while a document request is pending cannot change document identity", () => {
    const history = make()
    history.navigate(100, 10)
    history.fail(1, "cancelled", 11)
    const candidate = history.candidate(url, 12)!
    expect(candidate()).toBe(true)
    observed(history, "A", 13)
    history.start(2, url, 14)
    history.response(2, 403)
    // A request started before the diagnostic must retain its refusal through a same-document event.
    const other = make()
    other.start(2, url, 2)
    other.navigate(100, 10)
    other.fail(1, "cancelled", 11)
    const refusal = other.candidate(url, 12)!
    observed(other, "A", 13)
    other.response(2, 403)
    expect(refusal()).toBe(false)
    history.navigate(101, 20)
    expect(candidate()).toBe(false) // The prior uncommitted attempt was superseded.
    expect(classify(history, url, 21)).toBe(false)
  })
  test("old navigation failures and old-document cancellations cannot control a newer navigation", () => {
    const history = make()
    history.navigate(100, 10)
    history.navigate(101, 11)
    history.abort(100, 12)
    history.fail(1, "cancelled", 13)
    expect(classify(history, url, 14)).toBe(true)
    observed(history, "B", 15)
    history.start(2, asset, 16)
    history.navigate(102, 20)
    expect(classify(history, url, 22)).toBe(false)
    history.fail(2, "cancelled", 23)
    const candidate = history.candidate(url, 24)!
    history.abort(101, 24)
    expect(candidate()).toBe(true)
    history.abort(102, 25)
    expect(candidate()).toBe(false)
  })
  test("captures diagnostic-before-cancellation and rejects a witness after commit", () => {
    const history = make()
    history.navigate(100, 10)
    const candidate = history.candidate(url, 11)!
    expect(candidate()).toBe(false)
    history.fail(1, "cancelled", 12)
    expect(candidate()).toBe(true)
    observed(history, "B", 13)
    expect(candidate()).toBe(true)
    const late = make()
    late.navigate(100, 14)
    const after = late.candidate(url, 15)!
    observed(late, "B", 16)
    late.fail(1, "cancelled", 17)
    expect(after()).toBe(false)
  })
  test("unknown and stale asynchronous document observations never establish evidence", () => {
    const unknown = new DocumentRequests()
    unknown.abort(99, 0)
    unknown.response(9, 200)
    unknown.finish(9, 0)
    unknown.fail(9, "cancelled", 1)
    unknown.start(1, asset, 1)
    unknown.fail(1, "cancelled", 2)
    unknown.navigate(100, 3)
    expect(classify(unknown, url, 4)).toBe(false)
    const history = make()
    history.navigate(100, 10)
    const first = history.documentEvent(11)
    history.start(2, url, 12)
    const second = history.documentEvent(13)
    history.observeDocument(second, "B")
    history.observeDocument(first, "A")
    history.start(3, asset, 14)
    history.navigate(101, 20)
    history.fail(1, "cancelled", 21) // A does not supply B's witness.
    expect(classify(history, url, 22)).toBe(false)
    history.fail(3, "cancelled", 23)
    history.fail(2, "cancelled", 23)
    expect(classify(history, url, 24)).toBe(false) // The matching read's document was never known.
  })
  test("completion, failure and refusal evidence survives late duplicate events", () => {
    for (const outcome of ["finished", "failed", "refused"]) {
      const history = make()
      history.start(2, url, 1)
      history.navigate(100, 10)
      history.fail(1, "cancelled", 10)
      const candidate = history.candidate(url, 11)!
      if (outcome === "finished") history.finish(2, 13)
      if (outcome === "failed") { history.fail(2, "reset", 11); history.finish(2, 13) }
      if (outcome === "refused") { history.response(2, 403); history.response(2, 200) }
      history.fail(2, "cancelled", 12)
      history.fail(2, "cancelled", 13)
      expect(candidate()).toBe(false)
    }
  })
})
