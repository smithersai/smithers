// The app docs projection: toc.ts parsing, the site and Markdown-copy
// rewrites, the sidebar, and the script's write, check and stale-file paths
// run against a temporary tree.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { fromMarkdown } from "mdast-util-from-markdown"
import { copyBody, markdownCopy, parsePage, parseToc, sidebar, siteBody, sitePage } from "./sync-app-docs.mjs"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")

test("toc.ts parses as its literal sections and refuses anything else", () => {
  const toc = (list) => `export interface DocsSection { readonly label: string }\n\nexport const TOC: ReadonlyArray<DocsSection> = [\n${list}\n]\n`
  assert.deepEqual(parseToc(toc('  { label: "Get started", pages: ["welcome", "quickstart"] },\n  // a comment\n  { label: "On \\"your\\" Mac", pages: ["self-host"] }')), [
    { label: "Get started", pages: ["welcome", "quickstart"] },
    { label: "On \"your\" Mac", pages: ["self-host"] }
  ])
  assert.ok(parseToc(readFileSync(join(site, "docs/app/toc.ts"), "utf8")).length > 0, "the site's own toc.ts parses")
  assert.throws(() => parseToc(toc('  { label: "A", pages: ["a"] },\n  ...MORE')), /literal list/)
  assert.throws(() => parseToc(toc('  { label: "A", pages: [SLUG] }')), /other than page slugs/)
  assert.throws(() => parseToc(toc('  { label: "A", pages: ["Not A Slug"] }')), /other than page slugs/)
  assert.throws(() => parseToc("export const OTHER = []\n"), /no `export const TOC/)
})

test("a page reads as its title, summary and body", () => {
  assert.deepEqual(parsePage('---\ntitle: "Flows reference"\nsummary: Find and run flows.\n---\n\n\n## Find\n', "flows.md"), {
    title: "Flows reference",
    summary: "Find and run flows.",
    markdown: "## Find\n"
  })
  assert.throws(() => parsePage("## No frontmatter\n", "a.md"), /no --- frontmatter/)
  assert.throws(() => parsePage("---\ntitle: A\nauthor: B\n---\n", "a.md"), /not title or summary/)
  assert.throws(() => parsePage("---\ntitle: A\n---\n", "a.md"), /needs a title and a summary/)
})

test("sibling page links publish under /docs, with welcome at the index", () => {
  const body = "See [Flows](flows.md#change-a-flow), [home](welcome.md), [here](./self-host.md) and [top](#top).\n" +
    "Web: [GitHub](https://github.com/smithersai/smithers). Not a page: [up](../x.md), [file](notes.txt).\n" +
    "Code keeps `[Flows](flows.md)` as written.\n\n```md\n[Flows](flows.md)\n```\n"
  assert.equal(siteBody(body), "See [Flows](/docs/flows/#change-a-flow), [home](/docs/), [here](/docs/self-host/) and [top](#top).\n" +
    "Web: [GitHub](https://github.com/smithersai/smithers). Not a page: [up](../x.md), [file](notes.txt).\n" +
    "Code keeps `[Flows](flows.md)` as written.\n\n```md\n[Flows](flows.md)\n```\n")
  assert.equal(copyBody("[Flows](flows.md#pin) [home](welcome.md#a) [top](#top)"),
    "[Flows](https://smithers.sh/docs/flows/#pin) [home](https://smithers.sh/docs/#a) [top](#top)")
})

test("a block screenshot becomes a framed light and dark pair, each shown in its own theme", () => {
  const img = (variant, hidden, alt) => `<img src="/images/docs/repo-home.${variant}.webp" alt="${alt}" width="1440" height="900" loading="lazy" decoding="async" class="${hidden}:sl-hidden" />`
  const figure = (alt, indent = "") => [`<figure class="docs-shot">`, img("light", "dark", alt), img("dark", "light", alt), "</figure>"].map((line) => indent + line).join("\n")
  assert.equal(siteBody("Intro.\n\n![The \"Files\" button & Ask](images/repo-home.webp)\n\nAfter.\n"),
    `Intro.\n\n${figure("The &quot;Files&quot; button &amp; Ask")}\n\nAfter.\n`)
  // An HTML block ends at a blank line, so text touching the image gets one on each side.
  assert.equal(siteBody("Intro.\n![Home](images/repo-home.webp)\nAfter.\n"), `Intro.\n\n${figure("Home")}\n\nAfter.\n`)
  assert.equal(siteBody("![Home](images/repo-home.webp)\n```sh\nls\n```\n"), `${figure("Home")}\n\n\`\`\`sh\nls\n\`\`\`\n`)
  assert.equal(siteBody("1. Open it.\n\n   ![Home](images/repo-home.webp)\n"), `1. Open it.\n\n${figure("Home", "   ")}\n`)
  // Only a block image of the image directory is a screenshot.
  for (const text of ["Inline ![Home](images/repo-home.webp) image.\n", "![Logo](logo.png)\n", "```md\n![Home](images/repo-home.webp)\n```\n"]) {
    assert.equal(siteBody(text), text)
  }
  assert.equal(copyBody("![Home \\[beta\\]](images/repo-home.webp)\nNext.\n"),
    "![Home \\[beta\\]](https://smithers.sh/images/docs/repo-home.light.webp)\n\nNext.\n")
})

test("the site page carries its source, summary and Markdown copy; the copy opens with the title", () => {
  const page = { title: "Welcome to Smithers", summary: "What Smithers is.", markdown: "Body with [Flows](flows.md).\n" }
  assert.equal(sitePage("welcome", page), [
    "---",
    "# GENERATED by apps/site/scripts/sync-app-docs.mjs. Edit apps/site/docs/app/pages/welcome.md.",
    "editUrl: https://github.com/smithersai/smithers/edit/main/apps/site/docs/app/pages/welcome.md",
    "title: \"Welcome to Smithers\"",
    "description: \"What Smithers is.\"",
    "head:",
    "  - tag: link",
    "    attrs:",
    "      rel: alternate",
    "      type: text/markdown",
    "      href: /docs/index.md",
    "---",
    "",
    "Body with [Flows](/docs/flows/).",
    ""
  ].join("\n"))
  assert.match(sitePage("flows", page), /^ {6}href: \/docs\/flows\.md$/m)
  assert.equal(markdownCopy(page), "# Welcome to Smithers\n\n> What Smithers is.\n\nBody with [Flows](https://smithers.sh/docs/flows/).\n")
})

test("the sidebar follows toc.ts, puts Install beside self-hosting and ends with the reference", () => {
  const reference = {
    label: "Reference",
    items: [
      { label: "HTTP and RPC API", slug: "docs/reference/http-api" },
      { label: "CLI", slug: "docs/reference/cli" },
      { label: "Library API", slug: "docs/reference/api" }
    ]
  }
  assert.deepEqual(sidebar([
    { label: "Get started", pages: ["welcome", "quickstart"] },
    { label: "On your own Mac", pages: ["self-host"] },
    { label: "Flows", pages: ["flows"] }
  ]), [
    { label: "Get started", items: [{ slug: "docs" }, { slug: "docs/quickstart" }] },
    { label: "On your own Mac", items: [{ slug: "docs/self-host" }, { slug: "docs/installation" }] },
    { label: "Flows", items: [{ slug: "docs/flows" }] },
    reference
  ])
  // Without its section, Install keeps a group of its own; a section with no published page is dropped.
  assert.deepEqual(sidebar([{ label: "Get started", pages: ["welcome"] }, { label: "Later", pages: [] }]), [
    { label: "Get started", items: [{ slug: "docs" }] },
    { label: "On your own Mac", items: [{ slug: "docs/installation" }] },
    reference
  ])
})

test("the script writes, checks and retires its files in a copied tree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sync-app-docs-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ["sync-app-docs.mjs", "docs-text.mjs"]) cpSync(join(site, "scripts", name), join(root, "apps/site/scripts", name))
  symlinkSync(join(site, "node_modules"), join(root, "apps/site/node_modules"), "dir")
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const read = (path) => readFileSync(join(root, path), "utf8")
  const run = (...args) => spawnSync(process.execPath, [join(root, "apps/site/scripts/sync-app-docs.mjs"), ...args], { encoding: "utf8" })
  const toc = (pages) => `export const TOC: ReadonlyArray<DocsSection> = [\n  { label: "Get started", pages: ${JSON.stringify(pages)} }\n]\n`
  put("apps/site/docs/app/toc.ts", toc(["welcome", "quickstart", "flows"]))
  put("apps/site/docs/app/pages/welcome.md", "---\ntitle: Welcome\nsummary: Start here.\n---\n\nRead [Flows](flows.md).\n")
  put("apps/site/docs/app/pages/flows.md", "---\ntitle: Flows\nsummary: Run flows.\n---\n\nBack [home](welcome.md).\n")
  put("apps/site/src/content/docs/docs/installation.mdx", "---\ntitle: Install\n---\n")
  // gen-cli-reference.mjs owns the copies under public/docs/reference/.
  put("apps/site/public/docs/reference/cli.md", "# CLI reference\n")

  const refused = run()
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /toc\.ts lists quickstart, but apps\/site\/docs\/app\/pages\/quickstart\.md does not exist/)
  assert.equal(existsSync(join(root, "apps/site/src/data/docs-sidebar.json")), false)

  put("apps/site/docs/app/toc.ts", toc(["welcome", "flows"]))
  const written = run()
  assert.equal(written.status, 0, written.stderr)
  assert.match(read("apps/site/src/content/docs/docs/index.md"), /^Read \[Flows\]\(\/docs\/flows\/\)\.$/m)
  assert.equal(read("apps/site/public/docs/flows.md"), "# Flows\n\n> Run flows.\n\nBack [home](https://smithers.sh/docs/).\n")
  assert.deepEqual(JSON.parse(read("apps/site/src/data/docs-sidebar.json"))[0], { label: "Get started", items: [{ slug: "docs" }, { slug: "docs/flows" }] })
  assert.equal(run("--check").status, 0)

  put("apps/site/docs/app/pages/flows.md", "---\ntitle: Flows\nsummary: Run every flow.\n---\n\nBack [home](welcome.md).\n")
  const edited = run("--check")
  assert.equal(edited.status, 1)
  assert.match(edited.stderr, /app docs drift: apps\/site\/src\/content\/docs\/docs\/flows\.md/)
  assert.match(edited.stderr, /app docs drift: apps\/site\/public\/docs\/flows\.md/)
  assert.match(edited.stderr, /run node apps\/site\/scripts\/sync-app-docs\.mjs/)

  put("apps/site/docs/app/toc.ts", toc(["welcome"]))
  const dropped = run("--check")
  assert.equal(dropped.status, 1)
  assert.match(dropped.stderr, /apps\/site\/public\/docs\/flows\.md is no longer in apps\/site\/docs\/app\/toc\.ts/)
  assert.equal(run().status, 0)
  assert.equal(existsSync(join(root, "apps/site/src/content/docs/docs/flows.md")), false)
  assert.equal(existsSync(join(root, "apps/site/public/docs/flows.md")), false)
  assert.equal(existsSync(join(root, "apps/site/src/content/docs/docs/installation.mdx")), true, "pages the projection did not write stay")
  assert.equal(read("apps/site/public/docs/reference/cli.md"), "# CLI reference\n", "another projection's copy stays")
  assert.equal(run("--check").status, 0)
})


test("both docs formats preserve fenced links and screenshot examples verbatim", () => {
  const tick = String.fromCharCode(96)
  for (const marker of ["~", tick]) {
    for (const length of [3, 4, 5, 8]) {
      for (const indent of ["", "   "]) {
        const fence = marker.repeat(length)
        const code = [
          indent + fence + "md",
          "[Flows](flows.md)",
          "![Home](images/repo-home.webp)",
          marker.repeat(length - 1),
          "[Flows](flows.md)",
          "![Home](images/repo-home.webp)",
          (marker === "~" ? tick : "~").repeat(length),
          "[Flows](flows.md)",
          "![Home](images/repo-home.webp)",
          fence + " not a closing fence",
          fence + "\u00a0",
          "    " + fence,
          "\t" + fence,
          "[Flows](flows.md)",
          "![Home](images/repo-home.webp)",
          indent + marker.repeat(length + 1) + "\t"
        ].join("\n")
        for (const [body, link] of [[siteBody, "/docs/flows/"], [copyBody, "https://smithers.sh/docs/flows/"]]) {
          assert.equal(body("[Flows](flows.md)\n" + code + "\n[Flows](flows.md)\n"),
            "[Flows](" + link + ")\n" + code + "\n[Flows](" + link + ")\n")
          const unclosed = fence + "md\n[Flows](flows.md)\n![Home](images/repo-home.webp)"
          assert.equal(body(unclosed), unclosed)
        }
      }
    }
  }
})

test("a screenshot directly before a tilde or longer fence gets a separating blank line", () => {
  for (const fence of ["~~~", String.fromCharCode(96).repeat(4)]) {
    const code = fence + "md\n![Home](images/repo-home.webp)\n" + fence + "\n"
    assert.equal(siteBody("![Home](images/repo-home.webp)\n" + code),
      siteBody("![Home](images/repo-home.webp)\n") + "\n" + code)
    assert.equal(copyBody("![Home](images/repo-home.webp)\n" + code),
      "![Home](https://smithers.sh/images/docs/repo-home.light.webp)\n\n" + code)
  }
})

test("Markdown screenshot alt escapes survive copying and decode only for HTML", () => {
  const alts = [
    ["Use \\] here", "Use ] here"],
    ["Use \\[ here", "Use [ here"],
    ["Use \\\\ here", "Use \\ here"],
    ["Use \\\\\\] here", "Use \\] here"],
    ["Home \\[beta\\]", "Home [beta]"],
    ["Use \\*literal\\* \\& \\<tag\\> \\\"quote\\\"", "Use *literal* &amp; &lt;tag&gt; &quot;quote&quot;"]
  ]
  for (const [markdownAlt, htmlAlt] of alts) {
    const input = "![" + markdownAlt + "](images/repo-home.webp)\n"
    assert.equal(copyBody(input), "![" + markdownAlt + "](https://smithers.sh/images/docs/repo-home.light.webp)\n")
    const image = fromMarkdown(copyBody(input)).children[0].children[0]
    assert.equal(image.type, "image")
    assert.equal(image.alt, fromMarkdown(input).children[0].children[0].alt)
    assert.equal(image.url, "https://smithers.sh/images/docs/repo-home.light.webp")
    assert.equal(siteBody(input), [
      '<figure class="docs-shot">',
      ...[["light", "dark"], ["dark", "light"]].map(([variant, hidden]) =>
        '<img src="/images/docs/repo-home.' + variant + '.webp" alt="' + htmlAlt +
        '" width="1440" height="900" loading="lazy" decoding="async" class="' + hidden + ':sl-hidden" />'),
      "</figure>",
      ""
    ].join("\n"))
  }
})


test("code blocks nested in containers and indented code remain literal in both docs formats", () => {
  const tick = String.fromCharCode(96)
  for (const fence of ["~~~", tick.repeat(3), tick.repeat(4)]) {
    for (const [prefix, indent] of [["1. Example\n\n", "    "], ["- Example\n\n", "  "], ["", "> "]]) {
      const code = prefix + [
        fence + "md",
        "[Flows](flows.md)",
        "![Home](images/repo-home.webp)",
        fence
      ].map((line) => indent + line).join("\n") + "\n"
      assert.equal(siteBody(code), code)
      assert.equal(copyBody(code), code)
    }
  }
  const code = "    [Flows](flows.md)\n    ![Home](images/repo-home.webp)\n"
  assert.equal(siteBody(code), code)
  assert.equal(copyBody(code), code)
})


test("links after a list's code block still publish as list prose", () => {
  const code = "1. Example\n\n    ~~~txt\n    code\n    ~~~\n\n"
  const source = code + "    [Flows](flows.md)\n"
  assert.equal(siteBody(source), code + "    [Flows](/docs/flows/)\n")
  assert.equal(copyBody(source), code + "    [Flows](https://smithers.sh/docs/flows/)\n")
})
