// The app's side of the first paint (src/firstPaint/page.ts): it takes the shell once, and shows the shell every session
// answer the page reads, so a paint read for anyone else goes as that answer arrives.
import { describe, expect, test } from "vitest"
import { SESSION_ROUTE } from "../features/auth/contract"
import { followRoute, takeShell, verifyingFetch } from "./page"
import { FIRST_PAINT_GLOBAL, type SessionAnswer, type Shell } from "./shell"
import { SETTLED } from "./settled"

const recording = () => {
  const answers: Array<SessionAnswer> = []
  const routes: Array<[string, string]> = []
  const shell: Shell = {
    handOver: () => undefined,
    verify: (answer) => void answers.push(answer),
    routed: (pathname, search) => void routes.push([pathname, search]),
    revoke: () => {},
    outcome: () => "pending",
  }
  return { shell, answers, routes }
}

describe("the app's side of the first paint", () => {
  test("takes the shell the inline script left, once", () => {
    const { shell } = recording()
    const target: Record<string, unknown> = { [FIRST_PAINT_GLOBAL]: shell }
    expect(takeShell(target)).toBe(shell)
    expect(takeShell(target)).toBeUndefined()
    expect(SETTLED).toEqual({ "data-first-paint": "settled" })
  })

  test("the router's locations reach the shell, from the history's own location", () => {
    const { shell, routes } = recording()
    let listener = () => {}
    const stop = () => {}
    const history = { location: { pathname: "/a", search: "" }, subscribe: (heard: () => void) => { listener = heard; return stop } }
    expect(followRoute(undefined, history)).toBeUndefined()
    expect(followRoute(shell, history)).toBe(stop)
    history.location = { pathname: "/b", search: "?q=1" }
    listener()
    expect(routes).toEqual([["/b", "?q=1"]])
  })

  test("without a shell, fetch is the page's own", () => {
    expect(verifyingFetch(globalThis.fetch, undefined)).toBe(globalThis.fetch)
  })

  test("every session answer reaches the shell before the page reads it; nothing else does", async () => {
    const { shell, answers } = recording()
    const bodies: Record<string, Response> = {}
    const fetch = verifyingFetch((async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      return bodies[url]!.clone()
    }) as typeof globalThis.fetch, shell)
    const origin = "https://smithers.test"
    bodies[`${origin}${SESSION_ROUTE}`] = Response.json({ signedIn: true, personId: "person-1" })
    bodies[`${origin}/api/other`] = Response.json({ signedIn: false })
    bodies[`${origin}${SESSION_ROUTE}?again`] = new Response("not json", { status: 200 })
    const read = await fetch(`${origin}${SESSION_ROUTE}`)
    // The page still reads the whole answer.
    expect(await read.json()).toEqual({ signedIn: true, personId: "person-1" })
    await fetch(new Request(`${origin}/api/other`))
    await fetch(new Request(`${origin}${SESSION_ROUTE}?again`))
    bodies[`${origin}${SESSION_ROUTE}`] = new Response(null, { status: 503 })
    await fetch(`${origin}${SESSION_ROUTE}`)
    bodies[`${origin}${SESSION_ROUTE}`] = Response.json({ signedIn: true, personId: 7 })
    await fetch(`${origin}${SESSION_ROUTE}`)
    // A session answer, an unreadable one (no one), and one naming no person; a 503 says nothing.
    expect(answers).toEqual([
      { signedIn: true, personId: "person-1" },
      { signedIn: false, personId: undefined },
      { signedIn: true, personId: undefined },
    ])
  })
})
