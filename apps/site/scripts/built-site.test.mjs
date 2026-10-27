import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import {
  ASSET_HEADERS,
  checkAssetHeaders,
  checkBuiltSite,
  checkLandingActions,
  releaseReferences
} from "./check-built-site.mjs"

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "smithers-built-site-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

test("a canonical page alone does not satisfy the versioned URL emitted by the release", (t) => {
  const root = fixture(t, { "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>" })
  const result = checkBuiltSite(root, ["https://smithers.sh/changelogs/1.0.0-rc.0"])
  assert.equal(result.pageCount, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /missing https:\/\/smithers\.sh\/changelogs\/1\.0\.0-rc\.0/)
})

test("built HTTP aliases resolve release URLs and preserve migration anchors", (t) => {
  const root = fixture(t, {
    "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>",
    "docs/migration/1.0/index.html": "<h2 id=\"rewind\">Rewind</h2>",
    "_redirects": "/changelogs/1.0.0-rc.0 /changelogs/100-rc0/ 301\n/migration/1.0 /docs/migration/1.0/ 301\n"
  })
  const references = ["https://smithers.sh/changelogs/1.0.0-rc.0", "https://smithers.sh/migration/1.0#rewind"]
  assert.deepEqual(checkBuiltSite(root, references).failures, [])
  const missingAnchor = checkBuiltSite(root, ["https://smithers.sh/migration/1.0#removed-heading"])
  assert.equal(missingAnchor.failures.length, 1)
  assert.match(missingAnchor.failures[0], /missing anchor.*\/docs\/migration\/1\.0\/#removed-heading/)
})

test("the first redirect overrides an existing asset and preserves explicit fragment replacements", (t) => {
  const root = fixture(t, {
    "old/index.html": "<h2 id=\"old\">Stale page</h2>",
    "new/index.html": "<h2 id=\"new\">Current page</h2>",
    "_redirects": "/old /new/#new 301\n/old /missing 301\n"
  })
  assert.deepEqual(checkBuiltSite(root, ["/old#old"]).failures, [])
})

test("splat redirects and literal exceptions resolve in file order", (t) => {
  const root = fixture(t, {
    "index.html": "<a href=\"/api/renamed#current\">Old link</a><a href=\"/api/other\">Other API</a>",
    "docs/current/index.html": "<h2 id=\"current\">Current API</h2>",
    "docs/api/other/index.html": "<h1>Other API</h1>",
    "_redirects": "/api/renamed /docs/current/ 301\n/api/* /docs/api/:splat/ 301\n"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [])
})

test("more than 100 rules after the first splat rule fail, matching Cloudflare's dynamic-rule limit", (t) => {
  const literals = Array.from({ length: 101 }, (_, i) => `/old${i} /new/ 301`).join("\n")
  const pages = { "new/index.html": "<h1>New</h1>", "api/x/index.html": "<h1>x</h1>" }
  const late = fixture(t, { ...pages, "_redirects": `/api/* /api/:splat/ 301\n${literals}\n` })
  assert.throws(() => checkBuiltSite(late), /102 rules from the first splat rule onward count as dynamic/)
  const ordered = fixture(t, { ...pages, "_redirects": `${literals}\n/api/* /api/:splat/ 301\n` })
  assert.deepEqual(checkBuiltSite(ordered).failures, [])
})

test("missing redirect destinations and cycles fail even without a page linking them", (t) => {
  const root = fixture(t, {
    "index.html": "<h1>Home</h1>",
    "_redirects": "/old /missing 301\n/a /b 301\n/b /a 301\n"
  })
  const { failures } = checkBuiltSite(root)
  assert.ok(failures.some((failure) => /missing \/old/.test(failure)))
  assert.ok(failures.some((failure) => /redirect cycle/.test(failure)))
})

test("page links and assets retain their existing checks", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"/guide#absent\">Guide</a><img src=\"/missing.png\"><a href=\"https://example.com\">External</a>",
    "guide/index.html": "<h2 id=\"present\">Guide</h2>"
  })
  const { failures } = checkBuiltSite(root)
  assert.equal(failures.length, 2)
  assert.ok(failures.some((failure) => /missing anchor \/guide#absent/.test(failure)))
  assert.ok(failures.some((failure) => /missing \/missing\.png/.test(failure)))
})

/*
 * A page reaches the same route by four spellings, and the browser resolves
 * all four against the page it read them from. The checker must too: a
 * document-relative href is as broken as the root-relative one it duplicates.
 */
test("every internal URL form resolves against the emitting page, so all four fail alike when the route is missing", (t) => {
  const root = fixture(t, {
    "index.html": "<a href=\"/guide/\">Root-relative</a><a href=\"https://smithers.sh/guide/\">Absolute</a>" +
      "<a href=\"./guide/\">Relative</a><a href=\"guide/index.html\">Bare</a>" +
      "<a href=\"/absent/\">Root-relative</a><a href=\"https://smithers.sh/absent/\">Absolute</a>" +
      "<a href=\"./absent/\">Relative</a><img src=\"absent.png\">",
    "guide/index.html": "<h2 id=\"present\">Guide</h2>"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [
    "index.html: missing /absent/ (resolved to /absent/)",
    "index.html: missing https://smithers.sh/absent/ (resolved to /absent/)",
    "index.html: missing ./absent/ (resolved to /absent/)",
    "index.html: missing absent.png (resolved to /absent.png)"
  ])
})

test("a nested page resolves its own fragments and its sibling paths, and skips what this origin does not serve", (t) => {
  const root = fixture(t, {
    "docs/guide/index.html":
      "<h2 id=\"present\">Guide</h2><a href=\"#present\">This page</a><a href=\"#absent\">This page</a>" +
      "<a href=\"../reference/\">Sibling</a><a href=\"../missing/\">Sibling</a>" +
      "<a href=\"../reference/#present\">Sibling anchor</a><a href=\"../reference/#absent\">Sibling anchor</a>" +
      "<a href=\"mailto:hello@smithers.sh\">Mail</a><a href=\"\">This page</a>",
    "docs/reference/index.html": "<h2 id=\"present\">Reference</h2>"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [
    "docs/guide/index.html: missing anchor #absent (resolved to /docs/guide/index.html#absent)",
    "docs/guide/index.html: missing ../missing/ (resolved to /docs/missing/)",
    "docs/guide/index.html: missing anchor ../reference/#absent (resolved to /docs/reference/#absent)"
  ])
})

test("release URLs use the emitted removal table and exclude canonical verbs and prose punctuation", async (t) => {
  const root = fixture(t, {
    "packages/smithers/src/Unsupported.ts": `
export const migrationUrl = "https://smithers.sh/migration/1.0"
export const removedVerbs = [{ name: "rewind" }, { name: "worktrees", subcommands: ["list"] }, { name: "graph" }, { name: "new-removal" }]
export const removedFlags = [{ anchor: "databases" }]
`,
    "packages/smithers/src/cli/Compatibility.ts":
      `export const legacyArguments = (args) => args[0] === "graph" ? undefined : args`,
    "apps/site/src/data/removed-commands.json": JSON.stringify({
      migrationUrl: "https://smithers.sh/migration/1.0",
      anchors: ["rewind", "worktrees", "databases", "flows", "run-data"]
    }),
    "CHANGELOG.md":
      "See https://smithers.sh/changelogs/1.0.0-rc.0. Older https://smithers.sh/changelogs/0.34.0, also [current](https://smithers.sh/changelogs/1.0.0-rc.0)."
  })
  const references = await releaseReferences(root)
  assert.ok(references.includes("https://smithers.sh/migration/1.0#rewind"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#worktrees"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#databases"))
  assert.ok(!references.includes("https://smithers.sh/migration/1.0#graph"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#new-removal"))
  assert.deepEqual(references.filter((url) => url.includes("/changelogs/")), [
    "https://smithers.sh/changelogs/1.0.0-rc.0",
    "https://smithers.sh/changelogs/0.34.0"
  ])
})

test("social card images are required references, whether emitted by path or by site URL", (t) => {
  const root = fixture(t, {
    "index.html":
      "<meta property=\"og:image\" content=\"https://smithers.sh/media/absent.png\"><meta name=\"twitter:image\" content=\"/media/og.png\">",
    "docs/index.html":
      "<meta property=\"og:image\" content=\"https://cdn.example.com/card.png\"><meta name=\"twitter:image\" content=\"https://smithers.sh/media/og.png\">",
    "media/og.png": "png"
  })
  const { failures } = checkBuiltSite(root)
  assert.deepEqual(failures, [
    "index.html: missing https://smithers.sh/media/absent.png (resolved to /media/absent.png)"
  ])
})

test("the built _headers gives every /_astro chunk a year-long immutable cache", (t) => {
  const root = fixture(t, {
    "_headers": ["# hashed chunks", "/_astro/*", "  Cache-Control: public, max-age=31536000, immutable", ""].join("\n")
  })
  assert.deepEqual(checkAssetHeaders(root), [])
})

test("a _headers without the chunk rule or with a shorter cache fails, naming the header", (t) => {
  assert.deepEqual(checkAssetHeaders(fixture(t, {})), ["_headers: missing the /_astro/* rule"])
  const short = fixture(t, { "_headers": "/_astro/*\n  Cache-Control: public, max-age=60\n" })
  assert.deepEqual(checkAssetHeaders(short), [
    "_headers: /_astro/* must set cache-control: public, max-age=31536000, immutable (got public, max-age=60)"
  ])
})

test("the source public/_headers the build copies into dist already passes, so the build check is not the first to see it", () => {
  const publicDir = resolve(import.meta.dirname, "../public")
  assert.deepEqual(checkAssetHeaders(publicDir), [])
  assert.deepEqual(Object.keys(ASSET_HEADERS), ["cache-control"])
})

test("the landing carries the install command and its Docs and Source buttons", (t) => {
  const buttons =
    "<nav aria-label=\"Start\"><a class=\"landing-button\" href=\"/docs/installation/\">Docs</a><a class=\"landing-button\" href=\"https://github.com/smithersai/smithers\">Source</a></nav>"
  const run =
    "<div class=\"landing-command\"><code><span aria-hidden=\"true\">$ </span><span id=\"run-command\">npx smthrs@next generate flow coding</span></code><button type=\"button\" id=\"copy-install\">Copy</button></div>"
  const install = "<h1>Smithers is a codebase maintainer agent.</h1>" + run + buttons
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": install })), [])
  assert.deepEqual(checkLandingActions(fixture(t, { "index.html": "<h1>Empty</h1>" })), [
    "index.html: missing the install command's Copy button"
  ])
  assert.deepEqual(
    checkLandingActions(fixture(t, { "index.html": install.replace(" href=\"/docs/installation/\"", " href=\"/\"") })),
    ["index.html: missing the /docs/installation/ button"]
  )
  assert.deepEqual(
    checkLandingActions(fixture(t, { "index.html": install.replace("npx smthrs@next", "npm i -g smthrs@next") })),
    ["index.html: missing the npx run command"]
  )
  assert.deepEqual(checkLandingActions(fixture(t, {})), ["index.html: missing from the build"])
})

test("built pages reject the retired GitHub App installation URL", (t) => {
  const page = (slug) => `<a href="https://github.com/apps/${slug}/installations/new">Install Smithers</a>`
  assert.deepEqual(checkBuiltSite(fixture(t, { "index.html": page("smithers") })).failures, [
    "index.html: retired GitHub App URL: https://github.com/apps/smithers/installations/new"
  ])
  assert.deepEqual(checkBuiltSite(fixture(t, { "index.html": page("team-install") })).failures, [])
})

test("retired docs URLs reach Install while live page anchors remain checked", (t) => {
  const root = fixture(t, {
    "docs/installation/index.html": "<h2 id=\"install\">Install</h2>",
    "_redirects": "/docs/guides/old/ /docs/installation/ 301\n"
  })
  assert.deepEqual(checkBuiltSite(root, ["/docs/guides/old/#retired-heading"]).failures, [])
  assert.equal(checkBuiltSite(root, ["/docs/installation/#missing"]).failures.length, 1)
})

test("a docs page's Markdown copy reaches its screenshots and linked pages in the build", (t) => {
  const copy =
    "# Flows\n\n![The Flow card](https://smithers.sh/images/docs/flow-card.light.webp)\n\nSee [Quickstart](https://smithers.sh/docs/quickstart/#sign-in) and [GitHub](https://github.com/smithersai/smithers).\n"
  const root = fixture(t, {
    "docs/flows.md": copy,
    "docs/flows/index.html":
      "<link rel=\"alternate\" type=\"text/markdown\" href=\"/docs/flows.md\"><img src=\"/images/docs/flow-card.dark.webp\" alt=\"The Flow card\">",
    "docs/quickstart/index.html": "<h2 id=\"sign-in\">Sign in</h2>",
    "images/docs/flow-card.light.webp": "light",
    "images/docs/flow-card.dark.webp": "dark"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [])
  rmSync(join(root, "images/docs/flow-card.light.webp"))
  rmSync(join(root, "images/docs/flow-card.dark.webp"))
  writeFileSync(join(root, "docs/quickstart/index.html"), "<h2>Sign in</h2>")
  rmSync(join(root, "docs/flows.md"))
  writeFileSync(join(root, "docs/index.md"), copy)
  assert.deepEqual(checkBuiltSite(root).failures.sort(), [
    "docs/flows/index.html: missing /docs/flows.md (resolved to /docs/flows.md)",
    "docs/flows/index.html: missing /images/docs/flow-card.dark.webp (resolved to /images/docs/flow-card.dark.webp)",
    "docs/index.md: missing anchor https://smithers.sh/docs/quickstart/#sign-in (resolved to /docs/quickstart/#sign-in)",
    "docs/index.md: missing https://smithers.sh/images/docs/flow-card.light.webp (resolved to /images/docs/flow-card.light.webp)"
  ])
})

test("origin robots allows crawlers and advertises the sitemap", () => {
  const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")
  assert.match(robots, /^User-agent: \*$/m)
  assert.match(robots, /^Allow: \/$/m)
  assert.match(robots, /^Sitemap: https:\/\/smithers\.sh\/sitemap-index\.xml$/m)
  assert.doesNotMatch(robots, /^Disallow: \/$/m)
})


test("the bug door can link to the app-owned report route, but unknown app paths still fail", (t) => {
  const root = fixture(t, {
    "bug/index.html": '<a href="/app/bugs/report">Report a bug</a><a href="https://smithers.sh/app/bugs/report">Report</a>',
  })
  const contract = readFileSync(new URL("../../mvp/src/features/bugs/contract.ts", import.meta.url), "utf8")
  assert.match(contract, /export const BUG_FORM_PATH = "\/app\/bugs\/report"/)
  assert.deepEqual(checkBuiltSite(root).failures, [])
  assert.equal(checkBuiltSite(root, ["/app/bugs/missing"]).failures.length, 1)
  assert.equal(checkBuiltSite(root, ["/app/bugs/report#missing"]).failures.length, 1)
})

test("personal-flow and settings guides can link to declared app routes without allowing unknown routes", (t) => {
  const root = fixture(t, {
    "docs/guide/index.html": '<a href="https://smithers.sh/app/flows">Flows</a><a href="https://smithers.sh/app/settings">Settings</a>'
  })
  const router = readFileSync(new URL("../../mvp/src/router.tsx", import.meta.url), "utf8")
  for (const path of ["/app/flows", "/app/settings"]) {
    assert.ok(router.includes(`path: "${path}"`), path)
    assert.equal(checkBuiltSite(root, [`${path}#missing`]).failures.length, 1)
    assert.equal(checkBuiltSite(root, [`${path}/missing`]).failures.length, 1)
  }
  assert.deepEqual(checkBuiltSite(root).failures, [])
})
