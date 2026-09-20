/**
 * The defences the verification sweep found missing, each driven against the
 * assembled application rather than the function under it, because three of
 * the four holes were in how the route called the function and would not
 * have shown at all one layer down.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Cors from "../src/Cors.ts"
import * as Serve from "../src/Serve.ts"
import { serve, type Served } from "./Harness.ts"

/** A file outside the served directory, standing in for `~/.ssh/id_ed25519`. */
const sentinel = "SENTINEL-NOT-THE-SERVERS-TO-GIVE"

let served: Served
let outside: string

beforeAll(() => {
  served = serve()
  mkdirSync(join(served.directory, "src"), { recursive: true })
  writeFileSync(join(served.directory, "src", "inside.txt"), "inside\n")
  outside = mkdtempSync(join(tmpdir(), "smithers-opencode-outside-"))
  writeFileSync(join(outside, "sentinel.txt"), sentinel)
  // A link inside the served directory pointing at the file outside it.
  symlinkSync(join(outside, "sentinel.txt"), join(served.directory, "escape.txt"))
  // A link inside the served directory pointing at a file inside it, which
  // is an ordinary read and stays one.
  symlinkSync(join(served.directory, "src", "inside.txt"), join(served.directory, "alias.txt"))
})

afterAll(async () => {
  await served.dispose()
  rmSync(outside, { recursive: true, force: true })
})

const app = (path: string, init?: RequestInit): Promise<Response> =>
  served.handler(new Request(`http://test${path}`, init))

const content = (query: string) => app(`/file/content?${query}`)

describe("the file read is contained by the served directory", () => {
  it("takes its base from the served directory, not from the request", async () => {
    // The hole: the base came from the request's own `directory`, so
    // `target.startsWith(base + sep)` was a check the request wrote both
    // sides of and could not fail. Driven live it returned the operator's
    // OpenSSH private key.
    const escaped = await content(`directory=${encodeURIComponent(outside)}&path=sentinel.txt`)
    expect(escaped.status).toBe(404)
    expect(await escaped.text()).not.toContain(sentinel)

    const rooted = await content(
      `directory=${encodeURIComponent("/")}&path=${encodeURIComponent(outside.slice(1))}/sentinel.txt`
    )
    expect(rooted.status).toBe(404)

    const traversed = await content(
      `directory=${encodeURIComponent(join(served.directory, "src"))}&path=${encodeURIComponent("../../")}`
    )
    expect(traversed.status).toBe(404)

    // An absolute path outside was already refused, and stays refused.
    expect((await content(`path=${encodeURIComponent(join(outside, "sentinel.txt"))}`)).status).toBe(404)
  })

  it("still resolves a path from the directory the request names, inside the served one", async () => {
    // What the app does with a project-relative read: the parameter is
    // honoured as a place to resolve from, never as the containment base.
    const relative = await content(`directory=${encodeURIComponent(join(served.directory, "src"))}&path=inside.txt`)
    expect(relative.status).toBe(200)
    expect(await relative.json()).toEqual({ type: "text", content: "inside\n" })
    expect((await content("path=src/inside.txt")).status).toBe(200)
  })

  it("refuses a symlink that leads out of the served directory", async () => {
    // Survives the base fix on its own: the link's own name is inside the
    // served directory, and only the real path it resolves to is not.
    const followed = await content("path=escape.txt")
    expect(followed.status).toBe(404)
    expect(await followed.text()).not.toContain(sentinel)
  })

  it("reads a symlink that stays inside the served directory", async () => {
    const aliased = await content("path=alias.txt")
    expect(aliased.status).toBe(200)
    expect(await aliased.json()).toEqual({ type: "text", content: "inside\n" })
  })
})

describe("the cross-origin policy refuses rather than declines", () => {
  it("blocks a state-changing POST from a page anywhere on the internet", async () => {
    // A CORS-simple POST needs no preflight. Stamping no headers hides the
    // answer from the page and runs the route anyway, which is a session
    // created in the operator's repository by a page they only visited.
    const before = (await (await app("/session")).json()) as Array<unknown>
    const forged = await app("/session", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: "{}"
    })
    expect(forged.status).toBe(403)
    expect(await forged.json()).toEqual(Cors.forbiddenOrigin)
    const after = (await (await app("/session")).json()) as Array<unknown>
    expect(after.length).toBe(before.length)
  })

  it("blocks a loopback page by default and reads nothing for it", async () => {
    // Any dev server, preview or tool on any port of this machine served
    // that page, and the default bind asks it for no password.
    const read = await app("/file/content?path=src/inside.txt", {
      headers: { origin: "http://localhost:31337" }
    })
    expect(read.status).toBe(403)
    expect(await read.text()).not.toContain("inside")
    expect(Cors.allows("http://localhost:31337")).toBe(false)
    expect(Cors.allows("http://127.0.0.1:8080")).toBe(false)
  })

  it("keeps the hosted app and every client that sends no Origin working", async () => {
    const hosted = await app("/file/content?path=src/inside.txt", {
      headers: { origin: "https://app.opencode.ai" }
    })
    expect(hosted.status).toBe(200)
    expect(hosted.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    // The shipped TUI, and curl: no Origin, so no cross-origin decision.
    expect((await app("/file/content?path=src/inside.txt")).status).toBe(200)
  })

  it("lets a named loopback build back in", async () => {
    const local = serve({ bind: { cors: ["http://localhost:5173"] } })
    try {
      const allowed = await local.handler(
        new Request("http://test/session", { headers: { origin: "http://localhost:5173" } })
      )
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
      const other = await local.handler(
        new Request("http://test/session", { headers: { origin: "http://localhost:5174" } })
      )
      expect(other.status).toBe(403)
    } finally {
      await local.dispose()
    }
  })
})

describe("a --cors pattern the policy cannot use is refused at the bind", () => {
  it("refuses the star an operator reaches for first", () => {
    // `*` expanded to `[^/:]*`, which matches no origin at all, because
    // every origin carries the `:` and `//` of its scheme. The flag looked
    // like it allowed everything and allowed nothing, silently.
    const refused = Cors.patternRefusal("*")
    expect(refused).toContain("--cors *")
    expect(refused).toContain("https://*.opencode.ai")
    expect(Cors.allows("https://anything.example", ["*"])).toBe(false)
    expect(Serve.refusal({ ...Serve.defaultBind, cors: ["*"] })).toBe(refused)
    // And it is refused before the bind rule looks at the host at all.
    expect(Serve.refusal({ ...Serve.defaultBind, hostname: "0.0.0.0", cors: ["*"] })).toBe(refused)
  })

  it.each([
    "*",
    "localhost:5173",
    "*.opencode.ai",
    "https://app.opencode.ai/",
    "https://app.opencode.ai/path",
    "file://x",
    ""
  ])("refuses %o, which is not an origin", (pattern) => {
    expect(Cors.patternRefusal(pattern)).toContain("is not an origin")
    expect(Serve.refusal({ ...Serve.defaultBind, cors: [pattern] })).toBeDefined()
  })

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:*",
    "https://*.opencode.ai",
    "https://example.test"
  ])("admits %o", (pattern) => {
    expect(Cors.patternRefusal(pattern)).toBeUndefined()
    expect(Cors.refusal([pattern])).toBeUndefined()
    expect(Serve.refusal({ ...Serve.defaultBind, cors: [pattern] })).toBeUndefined()
  })

  it("names the first pattern it cannot use", () => {
    expect(Cors.refusal(["https://example.test", "*"])).toBe(Cors.patternRefusal("*"))
  })
})
