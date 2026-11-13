import { test } from "node:test"
import assert from "node:assert/strict"
import { docsText, mapMarkdownProse } from "./docs-text.mjs"

test("preserves example imports while removing MDX imports", () => {
  const source = 'import { Code } from "@astrojs/starlight/components"\n\n```ts title="main.ts"\nimport { Action } from "@smthrs/flow"\nconst value = 1\n```'
  const result = docsText(source)
  assert.ok(!result.includes("starlight/components"))
  assert.ok(result.includes('import { Action } from "@smthrs/flow"'))
})

test("exports navigation and diagram text", () => {
  const result = docsText('<CardGrid>\n<LinkCard title="Run" href="/docs/run/" description="Launch a flow." />\n</CardGrid>\n<DocsDiagram title="Resume" caption="Reuse the committed outcome." rows={[]} />')
  assert.match(result, /\[Run\]\(\/docs\/run\/\)/)
  assert.match(result, /Reuse the committed outcome/)
  assert.ok(!result.includes("<"))
})

test("preserves blank lines in fenced template literals while collapsing prose blank lines", () => {
  const fence = '```js\nconst content = `first\n\n\nsecond`\n```'
  const source = `Before\n\n\nparagraph.\n\n\n${fence}\n\n\nAfter\n\n\nparagraph.`
  assert.equal(docsText(source), `Before\n\nparagraph.\n\n${fence}\n\nAfter\n\nparagraph.`)
})

test("exports app screenshots with their captions for text readers", () => {
  const result = docsText('<AppScreenshot src="/images/app/home.png" alt="The repository home." caption="Choose a featured flow." />')
  assert.equal(result, '![The repository home.](/images/app/home.png)\n\nChoose a featured flow.')
})

test("expands imported help and version fields", () => {
  const result = docsText('<Code lang="text" code={help} />\nNode {versions.node}', { raw: { help: "Usage: smthrs flow list   \n" }, versions: { node: "26.4.0" } })
  assert.match(result, /```text\nUsage: smthrs flow list\n```/)
  assert.match(result, /Node 26\.4\.0/)
})

test("exports literal install commands and refuses unknown code bindings", () => {
  assert.match(docsText('<Code lang="bash" code={`pnpm add package`} />'), /pnpm add package/)
  assert.throws(() => docsText('<Code code={missing} />'), /Cannot export/)
})

test("removes wrapper indentation without changing fenced source", () => {
  const result = docsText('<Tabs>\n  <TabItem label="Node">\n```ts\nconst content = `kept  `\n```\n  </TabItem>\n</Tabs>')
  assert.ok(!/^ +$/m.test(result))
  assert.ok(result.includes('`kept  `'))
})

test("exports the theme-selected animation as its single image", () => {
  const result = docsText(
    '<picture>\n  <source srcset="/images/light.gif" media="(prefers-color-scheme: light)" />\n  <img src="/images/dark.gif" class="hero-anim" alt="The graph." loading="lazy" decoding="async" />\n</picture>'
  )
  assert.equal(result, "![The graph.](/images/dark.gif)")
})


test("prose rewrites preserve tilde and backtick fences with matching markers and lengths", () => {
  const tick = String.fromCharCode(96)
  for (const marker of ["~", tick]) {
    for (const length of [3, 4, 5, 8]) {
      const open = marker.repeat(length)
      const other = marker === "~" ? tick : "~"
      const code = [
        open + "md",
        "example",
        marker.repeat(length - 1),
        "example",
        other.repeat(length),
        "example",
        open + " not a closing fence",
        open + "\u00a0",
        "    " + open,
        "\t" + open,
        "example",
        "  " + marker.repeat(length + 1) + "\t"
      ].join("\n")
      assert.equal(mapMarkdownProse("example\n" + code + "\nexample", (prose) => prose.replaceAll("example", "rewritten")),
        "rewritten\n" + code + "\nrewritten")
    }
  }
})

test("unclosed fences preserve code through the end of the source", () => {
  for (const marker of ["~~~", String.fromCharCode(96).repeat(4)]) {
    for (const ending of ["", "\n"]) {
      const code = marker + "md\nexample" + ending
      assert.equal(mapMarkdownProse(code, (prose) => prose.replaceAll("example", "rewritten")), code)
    }
  }
  assert.equal(mapMarkdownProse("", (prose) => prose), "")
})

test("inline code stays literal while prose around it is rewritten", () => {
  const tick = String.fromCharCode(96)
  const code = tick + "example" + tick + " and " + tick.repeat(2) + "example " + tick + " here" + tick.repeat(2)
  assert.equal(mapMarkdownProse("example " + code + " example", (prose) => prose.replaceAll("example", "rewritten")),
    "rewritten " + code + " rewritten")
  // A backtick in a backtick fence's info string makes it prose.
  const invalid = tick.repeat(3) + "md" + tick + "\nexample"
  assert.equal(mapMarkdownProse(invalid, (prose) => prose.replaceAll("example", "rewritten")),
    tick.repeat(3) + "md" + tick + "\nrewritten")
})

test("portable docs preserve MDX examples inside tilde and longer fences", () => {
  const tick = String.fromCharCode(96)
  for (const marker of ["~~~", tick.repeat(4)]) {
    const code = [
      marker + "mdx",
      'import { Code } from "@astrojs/starlight/components"',
      '<LinkCard title="Example" href="/docs/" description="Keep this." />',
      "{/* a comment in code */}",
      "{versions.unknown}",
      "",
      "",
      tick.repeat(3),
      '<img src="example.png" alt="Example" />',
      marker
    ].join("\n")
    assert.equal(docsText("Before\n\n" + code + "\n\nAfter"), "Before\n\n" + code + "\n\nAfter")
  }
})


test("fences preserve line endings and keep adjacent prose rewritable", () => {
  const code = "  ~~~~md\nexample\n  ~~~~\t"
  const source = "example\n" + code + "\nexample\n~~~\nexample\n~~~\nexample"
  for (const eol of ["\n", "\r\n"]) {
    assert.equal(mapMarkdownProse(source.replaceAll("\n", eol), (prose) => prose.replaceAll("example", "rewritten")),
      ("rewritten\n" + code + "\nrewritten\n~~~\nexample\n~~~\nrewritten").replaceAll("\n", eol))
  }
  for (const code of ["~~~", "~~~md", "~~~md\n", "~~~md\n~~~", "~~~md\n~~~\n"]) {
    assert.equal(mapMarkdownProse(code, (prose) => prose.replaceAll("md", "text")), code)
  }
})


test("portable docs preserve code blocks inside lists and blockquotes", () => {
  const tick = String.fromCharCode(96)
  for (const fence of ["~~~", tick.repeat(3), tick.repeat(4)]) {
    for (const [prefix, indent] of [["1. Example\n\n", "    "], ["", "> "]]) {
      const code = prefix + [
        fence + "mdx",
        '<LinkCard title="Example" href="/docs/" description="Keep this." />',
        "{/* a comment in code */}",
        "{versions.unknown}",
        fence
      ].map((line) => indent + line).join("\n")
      assert.equal(docsText(code), code)
    }
  }
})


test("MDX wrappers do not hide fenced imports, components or comments", () => {
  for (const fence of ["~~~", String.fromCharCode(96).repeat(3)]) {
    const code = [
      fence + "mdx",
      'import { Action } from "@smthrs/flow"',
      '<LinkCard title="Example" href="/docs/" description="Keep this." />',
      "{/* a comment in code */}",
      "{versions.unknown}",
      fence
    ].join("\n")
    assert.equal(docsText('<Tabs>\n<TabItem label="Example">\n' + code + '\n</TabItem>\n</Tabs>'),
      "**Example**\n\n" + code)
  }
})


test("portable docs remove prose comments after a list's code block", () => {
  const code = "1. Example\n\n    ~~~txt\n    {/* code comment */}\n    ~~~\n\n"
  assert.equal(docsText(code + "    Before {/* prose comment */} after."),
    code + "    Before  after.")
})

test("portable docs expand links and plain code without retaining MDX setup", () => {
  assert.equal(docsText('---\ntitle: Example\n---\n\n<LinkButton href="/docs/">Read docs</LinkButton>'), "[Read docs](/docs/)")
  assert.equal(docsText('<Code code={help} />', { raw: { help: "Usage   \nnext   \n" } }),
    String.fromCharCode(96).repeat(3) + "text\nUsage\nnext\n" + String.fromCharCode(96).repeat(3))
  assert.throws(() => docsText("{versions.unknown}"), /Unknown version field: unknown/)
})
