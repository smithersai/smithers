// The views feature's pure parts (docs/features/views.md): reading a row by its template, the renderer's reply, and the
// form rules ChatApi and the step share. No database, no network.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { acceptedValues, formRefusal } from "./form"
import { readWritten, rendererCorrection, rendererTask, TIC_TAC_TOE } from "./renderer"
import { Schema } from "effect"
import { formOf, generatedOf, issuesOf, pageOf, repoOf, type ViewRow } from "./rows"
import { IssuesProps, RepoProps, View } from "./schema"

const row = (overrides: Partial<ViewRow>): ViewRow => ({
  id: "v",
  template: "webpage",
  props: { url: "https://example.com/" },
  title: null,
  state: null,
  html: null,
  interactions: null,
  revision: 0,
  ...overrides,
})

describe("a row by its template", () => {
  test("a page reads its props; a form and a generated view read nothing as a page", () => {
    expect(pageOf(row({}))).toEqual({ url: "https://example.com/" })
    expect(pageOf(row({ template: "link" }))).toEqual({ url: "https://example.com/" })
    const docs = { url: "https://example.com/docs", text: "# Guide", repository: "acme/widgets", path: "/guide.md" }
    expect(pageOf(row({ template: "docs", props: docs }))).toEqual(docs)
    expect(pageOf(row({ template: "form" }))).toEqual({ url: "" })
  })

  test("a form is a form only; a generated view needs its HTML, and names itself View without a title", () => {
    const state = { submitted: false }
    expect(formOf(row({ template: "form", props: { title: "T" }, state }))).toEqual({ props: { title: "T" }, state })
    expect(formOf(row({}))).toBeUndefined()
    expect(generatedOf(row({ template: "generated", html: "<p></p>", interactions: { a: { kind: "state" } }, revision: 2 })))
      .toEqual({ title: "View", html: "<p></p>", interactions: { a: { kind: "state" } }, revision: 2 })
    expect(generatedOf(row({ template: "generated", html: "<p></p>", title: "Board" }))?.title).toBe("Board")
    expect(generatedOf(row({ template: "generated", html: "<p></p>" }))?.interactions).toEqual({})
    expect(generatedOf(row({ template: "generated", html: "" }))).toBeUndefined()
    expect(generatedOf(row({}))).toBeUndefined()
  })
})

describe("a repository's view and its issues view", () => {
  test("read their props by template, and nothing as another", () => {
    const repo = { repo: "octocat/Spoon-Knife", path: "README.md", kind: "blob" }
    expect(repoOf(row({ template: "repo", props: repo }))).toEqual(repo)
    expect(repoOf(row({}))).toBeUndefined()
    expect(issuesOf(row({ template: "issues", props: { repo: "octocat/Spoon-Knife" } }))).toEqual({ repo: "octocat/Spoon-Knife" })
    expect(issuesOf(row({ template: "repo", props: repo }))).toBeUndefined()
    expect(pageOf(row({ template: "repo", props: repo }))).toEqual({ url: "" })
  })

  test("name a repository GitHub could have, and a path from its root", () => {
    const repoTakes = Schema.is(RepoProps)
    expect(repoTakes({ repo: "octocat/Spoon-Knife" })).toBe(true)
    expect(repoTakes({ repo: "octocat/Spoon-Knife", ref: "feature/x", kind: "tree", path: "docs/guide" })).toBe(true)
    expect(repoTakes({ repo: "octocat/Spoon-Knife", path: "" })).toBe(true)
    for (
      const refused of [
        { repo: "octocat" },
        { repo: "a/b/c" },
        { repo: "app/widgets" },
        { repo: "/b" },
        { repo: "octocat/Spoon-Knife", path: "docs//guide" },
        { repo: "octocat/Spoon-Knife", path: "./README.md" },
        { repo: "octocat/Spoon-Knife", path: "docs/../.." },
        { repo: "octocat/Spoon-Knife", ref: "" },
        { repo: "octocat/Spoon-Knife", ref: "two words" },
      ]
    ) expect([refused, repoTakes(refused)]).toEqual([refused, false])
    expect(Schema.is(IssuesProps)({ repo: "octocat/Spoon-Knife" })).toBe(true)
    expect(Schema.is(IssuesProps)({ repo: "octocat/Spoon-Knife/extra" })).toBe(false)
  })

  test("a row the device keeps holds its template's props", () => {
    const base = {
      id: "v",
      position: 1,
      createdAt: "2026-10-25T00:00:00Z",
      title: null,
      size: "inline",
      state: null,
      html: null,
      interactions: null,
      revision: 0,
    }
    expect(Schema.is(View)({ ...base, template: "repo", props: { repo: "octocat/Spoon-Knife" } })).toBe(true)
    expect(Schema.is(View)({ ...base, template: "issues", props: { repo: "octocat/Spoon-Knife" } })).toBe(true)
    expect(Schema.is(View)({ ...base, template: "repo", props: { url: "https://example.com/" } })).toBe(false)
  })
})

describe("the renderer's reply", () => {
  test("reads the title, first state and module, whatever the fence's language tag", () => {
    const reply = '```json\n{"title":" Board ","state":{"n":1}}\n```\n```TSX\n' + TIC_TAC_TOE + "```"
    expect(readWritten(reply)).toEqual({ title: "Board", state: { n: 1 }, code: TIC_TAC_TOE })
    expect(readWritten("```jsx\nexport default () => null\n```")).toEqual({
      title: "View",
      state: null,
      code: "export default () => null\n",
    })
  })

  test("says what is missing: no module, or a head that isn't JSON", () => {
    expect(readWritten("I can't.")).toBe("The reply has no ```tsx block with the module.")
    expect(readWritten("```json\n{nope\n```\n```tsx\nx\n```")).toBe("The ```json block isn't valid JSON.")
    expect(readWritten('```json\n[1]\n```\n```tsx\nx\n```')).toEqual({ title: "View", state: null, code: "x\n" })
  })

  test("the task names the size and the props as data; the correction quotes what failed", () => {
    expect(rendererTask({ description: "a board", size: "full" })).toContain("full screen")
    expect(rendererTask({ description: "a board", size: "inline", data: { a: 1 } })).toContain('{"a":1}')
    expect(rendererTask({ description: "a board", size: "inline" })).toContain("It has no props.")
    expect(rendererCorrection("1:1: refused")).toContain("1:1: refused")
  })
})

describe("the form rules", () => {
  const url = { type: "object", properties: { url: { type: "string", title: "URL" } }, required: ["url"] }

  test("a form needs a field it renders, in either document shape, and never a secret", () => {
    expect(formRefusal(url)).toBeUndefined()
    expect(formRefusal({ schema: url, definitions: {} })).toBeUndefined()
    expect(formRefusal({ type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } }))
      .toBeUndefined()
    expect(formRefusal({ type: "string" })).toBe("no_fields")
    // One of several objects renders the first that fits; a union with no object has no field.
    expect(formRefusal({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] }))
      .toBeUndefined()
    expect(formRefusal({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("no_fields")
    expect(formRefusal({ type: "object", properties: { a: { allOf: [{ type: "string", format: "password" }] } } })).toBe("secret")
    expect(formRefusal({ type: "object", properties: { a: { type: "string", writeOnly: true } } })).toBe("secret")
  })

  test("takes only values the form's own schema decodes, with no other field", () => {
    expect(acceptedValues(url, { url: "https://a.example" })).toEqual({ url: "https://a.example" })
    expect(acceptedValues(url, { url: 1 })).toBeUndefined()
    expect(acceptedValues(url, {})).toBeUndefined()
    expect(acceptedValues(url, { url: "x", other: "y" })).toBeUndefined()
    expect(acceptedValues({ type: "object", properties: { a: { $ref: "#/$defs/missing" } } }, { a: "x" })).toBeUndefined()
    // A schema with no properties takes no field.
    expect(acceptedValues({ type: "object" }, { a: "x" })).toBeUndefined()
  })
})

describe("what the engine worker loads", () => {
  test("the views modules its flows run on import no UI library: a worker has no DOM, and loading one breaks it", () => {
    for (const file of ["flows.ts", "steps.ts", "form.ts", "renderer.ts", "schema.ts", "api.ts", "contract.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      const imports = [...source.matchAll(/^import [^"]*"([^"]+)"/gm)].map((match) => match[1])
      expect([file, imports.filter((name) => /^(@smthrs\/ui|react|react-dom)(\/|$)/.test(name!))]).toEqual([file, []])
    }
  })
})
