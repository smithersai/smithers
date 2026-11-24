import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { legacySites, README_URL as SCRIPT_README_URL } from "../../../../.smithers/flows/docs-sync/package-docs.mjs"
import { answerIsUnclaimed, decide, handleDocsRedirect, MAX_UNCLAIMED_CACHE_ENTRIES, pageKey, UNCLAIMED_MARKER, unclaimedCacheSize } from "./docsRedirect"
import type { DocsRedirectEnv } from "./docsRedirect"
import { DOCS_PAGES, DOCS_REDIRECTS, README_URL } from "./docsRedirectMap"
import { Transport, transportFrom } from "./Http"
import * as ConfigProvider from "effect/ConfigProvider"
import { deployment } from "./deploymentConfig"

const REPO = "https://github.com/smithersai/smithers/"

type Seen = { readonly url: string; readonly host: string | null }

/** Runs the handler over a recording transport; `answer` stands in for origins and DNS. */
const run = (request: Request, env: DocsRedirectEnv, answer: (url: URL) => Response = () => new Response("origin", { status: 200 })) => {
  const seen: Array<Seen> = []
  const transport = transportFrom((input) => {
    const outgoing = input instanceof Request ? input : new Request(input)
    seen.push({ url: outgoing.url, host: new URL(outgoing.url).host })
    return Promise.resolve(answer(new URL(outgoing.url)))
  })
  return Effect.runPromise(handleDocsRedirect(request, env).pipe(Effect.provide(Layer.succeed(Transport, transport))))
    .then(response => ({ response, seen }))
}

const OFF: DocsRedirectEnv = { UNKNOWN_SLUGS: "off" }
const ON: DocsRedirectEnv = { UNKNOWN_SLUGS: "txt-marker" }

const dnsAnswer = (hostname: string, data: string, status = 0) =>
  Response.json({ Status: status, Answer: [{ name: `${hostname}.`, type: 16, TTL: 300, data: JSON.stringify(data) }] })

const FLOWS = `${REPO}blob/main/packages/smithers/flows/docs`
const FLOWS_FOLDER = `${REPO}tree/main/packages/smithers/flows/docs`

/** The Location one request answers with, asserting a 301 that never reached the network. */
const locationOf = async (url: string) => {
  const { response, seen } = await run(new Request(url), OFF)
  expect(response.status).toBe(301)
  expect(seen).toEqual([])
  return response.headers.get("location")
}

describe("pages", () => {
  test("each kind of old page path lands on its file in the package's docs folder", async () => {
    for (const [path, location] of [
      ["/quickstart/", `${FLOWS}/quickstart.md`],
      ["/installation/", `${FLOWS}/installation.md`],
      ["/troubleshooting/", `${FLOWS}/troubleshooting.md`],
      ["/guides/stand-up-a-node-runtime/", `${FLOWS}/guides/stand-up-a-node-runtime.md`],
      ["/concepts/aggregate-surface/", `${FLOWS}/concepts/aggregate-surface.md`],
      ["/reference/api/", `${FLOWS}/api.md`],
      ["/", FLOWS_FOLDER]
    ]) expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(location!)
  })

  test("a flows path that starts with a nested package's directory lands in that package's docs folder", async () => {
    const nested = `${REPO}blob/main/packages/smithers/flows`
    for (const [path, location] of [
      ["/time-travel/quickstart/", `${nested}/time-travel/docs/quickstart.md`],
      ["/time-travel/guides/rewind-a-run/", `${nested}/time-travel/docs/guides/rewind-a-run.md`],
      ["/flow/guides/inspect-the-plan/", `${nested}/flow/docs/guides/inspect-the-plan.md`],
      ["/time-travel/reference/api/", `${nested}/time-travel/docs/api.md`],
      ["/time-travel/quickstart", `${nested}/time-travel/docs/quickstart.md`],
      ["/time-travel/", `${REPO}tree/main/packages/smithers/flows/time-travel/docs`]
    ]) expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(location!)
    // Not a package under packages/smithers/flows, or no page of one: the flows folder, as before.
    for (const path of ["/model/quickstart/", "/time-travel/no-such-page/"]) {
      expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(FLOWS_FOLDER)
    }
    // Only flows answers for nested packages.
    expect(await locationOf("https://agent.smithers.sh/model/quickstart/")).toBe(DOCS_REDIRECTS.get("agent")!)
  })

  test("a path with or without its trailing slash or index.html names the same page", async () => {
    for (const path of ["/quickstart", "/quickstart/", "/quickstart/index.html"]) {
      expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(`${FLOWS}/quickstart.md`)
    }
    for (const path of ["", "/", "/index.html"]) expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(FLOWS_FOLDER)
  })

  test("any path under /reference/api/ was the API page", async () => {
    for (const path of ["/reference/api", "/reference/api/flow/", "/reference/api/a/b/c/index.html"]) {
      expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(`${FLOWS}/api.md`)
    }
  })

  test("a nested README lands on its folder; another package's pages land in that package", async () => {
    expect(await locationOf("https://cli.smithers.sh/reference/cli/")).toBe(`${REPO}tree/main/packages/smithers/docs/reference/cli`)
    expect(await locationOf("https://cli.smithers.sh/reference/cli/seats/")).toBe(`${REPO}blob/main/packages/smithers/docs/reference/cli/seats.md`)
    expect(await locationOf("https://engine.smithers.sh/concepts/retries/?x=1#y"))
      .toBe(`${REPO}blob/main/packages/smithers/flows/engine/docs/concepts/retries.md`)
  })

  test("a path that names no page lands on the docs folder", async () => {
    for (const path of ["/nope/", "/guides/", "/quickstart/extra/", "/QUICKSTART/", "/quickstart.md", "//quickstart/"]) {
      expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(FLOWS_FOLDER)
    }
  })

  test("the query never reaches the Location", async () => {
    for (const query of ["?x=1", "?next=//evil.example", "?%0d%0aSet-Cookie:x=1", "?/../../x/"]) {
      expect(await locationOf(`https://flows.smithers.sh/quickstart/${query}`)).toBe(`${FLOWS}/quickstart.md`)
      expect(await locationOf(`https://flows.smithers.sh/nope/${query}`)).toBe(FLOWS_FOLDER)
    }
  })

  test("encoded characters decode to a lookup key and nothing more", async () => {
    // An encoded letter is the page it spells; the URL parser resolves %2e%2e as `..`.
    expect(await locationOf("https://flows.smithers.sh/quick%73tart/")).toBe(`${FLOWS}/quickstart.md`)
    expect(await locationOf("https://flows.smithers.sh/guides%2Fstand-up-a-node-runtime/")).toBe(`${FLOWS}/guides/stand-up-a-node-runtime.md`)
    expect(await locationOf("https://flows.smithers.sh/%2e%2e/%2e%2e/quickstart/")).toBe(`${FLOWS}/quickstart.md`)
    // Decoded traversal, malformed escapes and control characters name no page.
    for (const path of ["/..%2f..%2fquickstart/", "/guides/..%2Fquickstart/", "/%E0%A4%A/", "/%ZZ/", "/quickstart%00/", "/%0d%0aSet-Cookie:x=1/"]) {
      expect(await locationOf(`https://flows.smithers.sh${path}`)).toBe(FLOWS_FOLDER)
    }
  })

  test("path traversal resolves before the lookup and never leaves the map", async () => {
    expect(await locationOf("https://flows.smithers.sh/../../x/")).toBe(FLOWS_FOLDER)
    expect(await locationOf("https://flows.smithers.sh/guides/../quickstart/")).toBe(`${FLOWS}/quickstart.md`)
    expect(await locationOf("https://flows.smithers.sh/../../../../etc/passwd")).toBe(FLOWS_FOLDER)
  })

  test("pageKey decodes, drops index.html and ends in a slash", () => {
    expect(pageKey("/quickstart")).toBe("/quickstart/")
    expect(pageKey("/quickstart/index.html")).toBe("/quickstart/")
    expect(pageKey("/index.html")).toBe("/")
    expect(pageKey("/a%2Fb")).toBe("/a/b/")
    expect(pageKey("/%E0%A4%A")).toBeUndefined()
  })
})

describe("known slugs", () => {

  test("the legacy aliases keep their old hostnames", async () => {
    for (const [host, dir] of [["smithers-patterns", "packages/smithers/flows/patterns"], ["smithers-sync", "packages/smithers/flows/sync"], ["cli", "packages/smithers"]]) {
      const { response } = await run(new Request(`https://${host}.smithers.sh/`), OFF)
      expect(response.headers.get("location")).toBe(`${REPO}tree/main/${dir}/docs`)
    }
  })

  test("the path never reaches the Location: traversal, encoded and scheme-relative paths", async () => {
    const expected = DOCS_REDIRECTS.get("flow")
    for (const path of ["/../../evil", "/%2e%2e/%2e%2e/evil", "/..%2f..%2fevil", "//evil.example/x", "/%0d%0aSet-Cookie:x=1", "/@evil.example", "/\\evil.example"]) {
      const { response } = await run(new Request(`https://flow.smithers.sh${path}`), OFF)
      expect(response.status).toBe(301)
      expect(response.headers.get("location")).toBe(expected!)
    }
  })

  test("every Location is the repository, built from the map, never from the Host", () => {
    for (const [slug, location] of DOCS_REDIRECTS) {
      expect(location.startsWith(`${REPO}tree/main/`)).toBe(true)
      expect(location.endsWith("/docs")).toBe(true)
      expect(location).not.toContain(`${slug}.smithers.sh`)
      expect(new URL(location).host).toBe("github.com")
    }
    expect(README_URL).toBe(`${REPO}blob/main/README.md`)
  })

  test("every page Location is a file or folder inside that slug's own docs folder, or for flows a nested package's", () => {
    expect([...DOCS_PAGES.keys()]).toEqual([...DOCS_REDIRECTS.keys()])
    for (const [slug, pages] of DOCS_PAGES) {
      expect(pages.get("/")).toBe(DOCS_REDIRECTS.get(slug)!)
      for (const [path, location] of pages) {
        expect(path).toMatch(/^\/(?:[a-z0-9_.-]+\/)*$/)
        // flows also answers for each package nested under it, at /<directory name>/.
        const folders = [DOCS_REDIRECTS.get(slug)!]
        if (slug === "flows") folders.push(`${REPO}tree/main/packages/smithers/flows/${path.split("/")[1]}/docs`)
        expect(folders.some(folder => location === folder || location.startsWith(`${folder}/`) ||
          (location.startsWith(`${folder.replace("/tree/main/", "/blob/main/")}/`) && location.endsWith(".md")))).toBe(true)
        expect(location).not.toContain("..")
        expect(new URL(location).host).toBe("github.com")
      }
    }
  })

  test("hostname casing and an explicit default port select the same slug", async () => {
    const { response } = await run(new Request("https://FLOW.Smithers.SH:443/"), OFF)
    expect(response.headers.get("location")).toBe(DOCS_REDIRECTS.get("flow")!)
  })
})

describe("every other hostname passes through unchanged", () => {
  test("non-slug hosts, look-alikes and deeper names reach their origin untouched", async () => {
    for (const url of ["https://smithers.sh/docs", "https://build.smithers.sh/cache", "https://status.smithers.sh/",
      "https://flow.smithers.sh.evil.example/", "https://evilflow.smithers.sh/", "https://x.flow.smithers.sh/",
      "https://flow.smithers.sh./", "https://flow.example.com/"]) {
      for (const env of [OFF, ON]) {
        // Under txt-marker a single-label name is first checked in DNS; no marker, so it still passes.
        const { response, seen } = await run(new Request(url, { method: "POST", body: "payload" }), env,
          target => target.host === "cloudflare-dns.com" ? Response.json({ Status: 0 }) : new Response("origin", { status: 207 }))
        expect(response.status).toBe(207)
        expect(await response.text()).toBe("origin")
        expect(seen.filter(s => s.host !== "cloudflare-dns.com")).toEqual([{ url, host: new URL(url).host }])
        if (env === OFF) expect(seen).toHaveLength(1)
      }
    }
  })

  test("a method, body and headers arrive at the origin as sent", async () => {
    let received: { method: string; body: string; cookie: string | null } | undefined
    const transport = transportFrom(async (input) => {
      const request = input as Request
      received = { method: request.method, body: await request.text(), cookie: request.headers.get("cookie") }
      return new Response(null, { status: 204 })
    })
    const response = await Effect.runPromise(handleDocsRedirect(
      new Request("https://status.smithers.sh/api", { method: "PUT", body: "x=1", headers: { cookie: "a=b" } }), OFF
    ).pipe(Effect.provide(Layer.succeed(Transport, transport))))
    expect(response.status).toBe(204)
    expect(received).toEqual({ method: "PUT", body: "x=1", cookie: "a=b" })
  })

  test("an unreachable origin is a 502, not a redirect", async () => {
    const transport = transportFrom(() => Promise.reject(new Error("connect refused")))
    const response = await Effect.runPromise(handleDocsRedirect(new Request("https://status.smithers.sh/"), OFF)
      .pipe(Effect.provide(Layer.succeed(Transport, transport))))
    expect(response.status).toBe(502)
  })
})

describe("unknown slugs", () => {
  test("off by default: an unknown single-label host passes through and DNS is never asked", async () => {
    for (const env of [OFF, {}]) {
      const { response, seen } = await run(new Request("https://unknown-docs-slug.smithers.sh/deep"), env)
      expect(response.status).toBe(200)
      expect(seen.map(s => s.host)).toEqual(["unknown-docs-slug.smithers.sh"])
    }
  })

  test("txt-marker: a name that only the wildcard answers goes to the README", async () => {
    const { response, seen } = await run(new Request("https://unknown-a.smithers.sh/deep/path"), ON,
      url => dnsAnswer(url.searchParams.get("name")!, UNCLAIMED_MARKER))
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe(README_URL)
    expect(seen.map(s => s.host)).toEqual(["cloudflare-dns.com"])
  })

  test("txt-marker: a name with its own record (no marker) passes through", async () => {
    const { response, seen } = await run(new Request("https://claimed-b.smithers.sh/"), ON,
      url => url.host === "cloudflare-dns.com" ? Response.json({ Status: 0 }) : new Response("claimed", { status: 401 }))
    expect(response.status).toBe(401)
    expect(seen.map(s => s.host)).toEqual(["cloudflare-dns.com", "claimed-b.smithers.sh"])
  })

  test("txt-marker: DNS failure reads as claimed and passes through", async () => {
    for (const [host, dns] of [["dns-down-c", () => new Response("", { status: 503 })], ["dns-garbage-d", () => new Response("not json")]] as const) {
      const { response, seen } = await run(new Request(`https://${host}.smithers.sh/`), ON,
        url => url.host === "cloudflare-dns.com" ? dns() : new Response("origin"))
      expect(response.status).toBe(200)
      expect(seen.at(-1)?.host).toBe(`${host}.smithers.sh`)
    }
  })

  test("txt-marker: a scan of 5,000 random names keeps the DNS cache at its cap, and a recent name stays cached", async () => {
    const answer = (url: URL) => url.host === "cloudflare-dns.com" ? Response.json({ Status: 0 }) : new Response("origin")
    for (let i = 0; i < 5_000; i++) {
      await run(new Request(`https://scan-${i}.smithers.sh/`), ON, answer)
      expect(unclaimedCacheSize()).toBeLessThanOrEqual(MAX_UNCLAIMED_CACHE_ENTRIES)
    }
    expect(unclaimedCacheSize()).toBe(MAX_UNCLAIMED_CACHE_ENTRIES)
    const { seen } = await run(new Request("https://scan-4999.smithers.sh/"), ON, answer)
    expect(seen.map(s => s.host)).toEqual(["scan-4999.smithers.sh"])
    const evicted = await run(new Request("https://scan-0.smithers.sh/"), ON, answer)
    expect(evicted.seen.map(s => s.host)).toEqual(["cloudflare-dns.com", "scan-0.smithers.sh"])
  })

  test("the marker must answer for the queried name, with the exact data and NOERROR", () => {
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(true)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "b.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 0, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"other"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", { Status: 3, Answer: [{ name: "a.smithers.sh.", type: 16, data: `"${UNCLAIMED_MARKER}"` }] })).toBe(false)
    expect(answerIsUnclaimed("a.smithers.sh", null)).toBe(false)
  })
})

describe("the map, the routes and the package list agree", () => {
  const config = Effect.runSync(deployment.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DOCS_REDIRECT_ZONE: "smithers.sh" })))))

  // .smithers/flows/docs-sync/package-docs-redirect.test.mjs holds docsRedirectMap.ts to a fresh generation:
  // its target declares every docs file the map is built from.
  test("docsRedirectMap.ts carries the generator's README target", () => {
    expect(README_URL).toBe(SCRIPT_README_URL)
  })

  test("the Worker claims exactly the retired docs-site hostnames: no wildcard, no other host", () => {
    expect(config.name).toBe("smithers-docs-redirect")
    expect(config.main).toBe("src/worker.ts")
    expect(config.routes).toEqual(legacySites.map(([slug]) => ({ pattern: `${slug}.smithers.sh/*`, zoneName: "smithers.sh" })))
    expect([...DOCS_REDIRECTS.keys()]).toEqual(legacySites.map(([slug]) => slug))
    expect(config.env).toEqual({ UNKNOWN_SLUGS: "off", DOCS_REDIRECT_ZONE: "smithers.sh" })
  })

  test("a configured zone serves the retired sites and passes other zones through", async () => {
    const env = { DOCS_REDIRECT_ZONE: "example.org", UNKNOWN_SLUGS: "off" }
    const match = await run(new Request("https://flow.example.org/"), env)
    expect(match.response.headers.get("location")).toBe(DOCS_REDIRECTS.get("flow")!)
    const other = await run(new Request("https://flow.smithers.sh/"), env)
    expect(other.seen.map(call => call.host)).toEqual(["flow.smithers.sh"])
  })

  test("the config names the zone, never a hosted account's zone ID", () => {
    const source = readFileSync(fileURLToPath(new URL("./deploymentConfig.ts", import.meta.url)), "utf8")
    expect(source).not.toMatch(/zone_id|\b[0-9a-f]{32}\b/)
  })

  test("no route names a hostname that serves something other than a docs site", () => {
    // Inventoried 2026-10-06 (README.md); each answers for another service.
    const others = ["smithers.sh", "www", "canary", "api", "aomi", "backend.aomi", "automate", "baml-unplugin-pr", "billing",
      "bug", "bugs", "build", "capabilities-and-segments", "chat", "code", "connectors", "cron", "cron-schedules", "ddd",
      "deck", "docs-next", "download", "eliza", "ferric", "hermes", "identity", "init", "kimibenchmarks", "monitor",
      "openclaw", "plugins", "reco", "self-healing", "signal", "status", "storybook", "sync", "technical-deck",
      "telegram", "ui", "ui-preview", "webhooks", "patterns", "build-cli", "targets"]
    const hosts = config.routes.map(route => route.pattern.replace(/\/\*$/, ""))
    for (const other of others) expect(hosts).not.toContain(other === "smithers.sh" ? other : `${other}.smithers.sh`)
  })

  test("decide: the hostname picks the site, the path only a page of it", () => {
    expect(decide(new URL("https://flow.smithers.sh/anything"))).toEqual({ kind: "redirect", location: DOCS_REDIRECTS.get("flow")! })
    expect(decide(new URL("https://flow.smithers.sh/quickstart/"))).toEqual({ kind: "redirect", location: DOCS_PAGES.get("flow")!.get("/quickstart/")! })
    expect(decide(new URL("https://build.smithers.sh/quickstart/"))).toEqual({ kind: "unknown-slug", hostname: "build.smithers.sh" })
    expect(decide(new URL("https://nope.smithers.sh/"))).toEqual({ kind: "unknown-slug", hostname: "nope.smithers.sh" })
    expect(decide(new URL("https://a.b.smithers.sh/"))).toEqual({ kind: "pass" })
  })
})
