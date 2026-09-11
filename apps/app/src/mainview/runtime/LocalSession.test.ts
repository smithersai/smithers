import { describe, expect, test } from "bun:test"
import { LOCAL_SESSION_HEADER, LOCAL_SESSION_META } from "@smthrs/rpc/LocalSession"
import { createAppFetch, localSocketProtocols, readLocalSessionToken } from "./LocalSession"

const TOKEN = "A".repeat(42) + "_"

describe("browser local-session transport", () => {
  test("reads only a valid injected token", () => {
    const source = { querySelector: () => ({ content: TOKEN }) } as unknown as Pick<Document, "querySelector">
    expect(readLocalSessionToken(source)).toBe(TOKEN)
    expect(LOCAL_SESSION_META).toBe("smithers-local-session")
  })

  test("adds the token only to same-origin API calls", async () => {
    const seen: Array<{ readonly input: string; readonly headers: Headers }> = []
    const appFetch = createAppFetch({
      token: TOKEN,
      location: { href: "http://127.0.0.1:4321/app", origin: "http://127.0.0.1:4321" },
      fetchImpl: async (input, init) => {
        seen.push({ input: input.toString(), headers: new Headers(init?.headers) })
        return new Response(null, { status: 204 })
      }
    })
    await appFetch("/api/repos")
    await appFetch("https://smithers-cloud.test/api/repos")
    await appFetch("/assets/app.js")
    expect(seen[0]?.headers.get(LOCAL_SESSION_HEADER)).toBe(TOKEN)
    expect(seen[1]?.headers.has(LOCAL_SESSION_HEADER)).toBe(false)
    expect(seen[2]?.headers.has(LOCAL_SESSION_HEADER)).toBe(false)
    expect(localSocketProtocols(TOKEN)).toEqual([`smithers.local.${TOKEN}`])
  })
})
