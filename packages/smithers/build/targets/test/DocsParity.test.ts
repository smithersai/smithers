import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageDiscovery from "../../build-cli/src/PackageDiscovery.ts"
import * as PackageExec from "../../build-cli/src/PackageExec.ts"
import { PackageIndex } from "../../build-cli/src/PackageIndex.ts"
import * as PackageLoader from "../../build-cli/src/PackageLoader.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const badges = [
  "# my-package",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/build)",
  "[![npm](https://img.shields.io/npm/v/my-package)](https://npm.example/my-package)",
  ""
].join("\n")

const real = [
  "# my-package",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/build)",
  "",
  "The package turns a declared plan into a keyed, cacheable target graph and",
  "reports every step it skipped, so a rebuild explains itself rather than",
  "silently reusing an answer.",
  "",
  "## Install",
  "",
  "```sh",
  "pnpm add my-package",
  "```"
].join("\n")

describe("DocsParity.summarize", () => {
  it("reads the first level-one heading as the title", () => {
    expect(DocsParity.summarize(real).title).toBe("my-package")
    expect(DocsParity.summarize("## only a subheading\n").title).toBeUndefined()
    expect(DocsParity.summarize("#not-a-heading\n").title).toBeUndefined()
  })

  it("counts no prose in a README that is a title over a badge row", () => {
    expect(DocsParity.summarize(badges)).toEqual({ title: "my-package", proseCharacters: 0 })
  })

  it("counts the prose a reader would actually read", () => {
    const summary = DocsParity.summarize(real)
    expect(summary.title).toBe("my-package")
    expect(summary.proseCharacters).toBeGreaterThan(DocsParity.defaultMinimumProseCharacters)
  })

  it("ignores headings, lists, quotes, tables, and thematic breaks", () => {
    const text = [
      "# t",
      "",
      "## heading",
      "",
      "- a list item that is quite long but is still not prose at all",
      "",
      "> a blockquote that is quite long but is still not prose at all",
      "",
      "| a | b |",
      "| - | - |",
      "",
      "---"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("ignores tables without leading pipes and indented code", () => {
    const text = [
      "# t",
      "",
      "name | role",
      "--- | ---",
      "alpha | producer",
      "",
      "    const proseLookingName = 'this is code, not a paragraph'"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("ignores fenced code even when it contains blank lines and prose", () => {
    const text = [
      "# t",
      "",
      "```ts",
      "const a = 1",
      "",
      "// this comment is long enough to look like prose if it were counted",
      "```"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("closes a fence only with the same marker and sufficient length", () => {
    const text = [
      "# t",
      "",
      "````ts",
      "~~~",
      "this still belongs to the code block even though it looks like prose",
      "```",
      "this also belongs to the four-backtick code block",
      "````"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })

  it("keeps link text and drops link targets, images, and markers", () => {
    expect(DocsParity.summarize("# t\n\nSee [the plan](https://example.com/a/very/long/target).\n"))
      .toEqual({ title: "t", proseCharacters: "See the plan.".length })
    expect(DocsParity.summarize("# t\n\n`code` and *emphasis* and _more_.\n").proseCharacters)
      .toBe("code and emphasis and more.".length)
  })

  it("counts no prose in reference definitions or bare-link paragraphs", () => {
    const text = [
      "# t",
      "",
      "[build]: https://ci.example/a/very/long/path/that/is/not/documentation",
      "",
      "https://example.com/a/very/long/path/that/is/not/documentation"
    ].join("\n")
    expect(DocsParity.summarize(text).proseCharacters).toBe(0)
  })
})

describe("DocsParity.fences", () => {
  it("reads each fence's language and body, closing only on a matching marker", () => {
    const text = [
      "prose",
      "```ts title=\"x.ts\"",
      "const a = 1",
      "",
      "```",
      "~~~~vibe",
      "~~~",
      "body",
      "~~~~~",
      "```",
      "unclosed"
    ].join("\r\n")
    expect(DocsParity.fences(text)).toEqual([
      { language: "ts", body: "const a = 1\n" },
      { language: "vibe", body: "~~~\nbody" },
      { language: "", body: "unclosed" }
    ])
  })
})

describe("DocsParity.exampleProblem", () => {
  const example = {
    page: "packages/a/docs/quickstart.md",
    example: "packages/a/examples/quickstart.vibe",
    test: "packages/a/test/quickstart.test.vibe"
  }
  const source = "export const answer = 42\n"
  const page = (body: string) =>
    `# Quickstart\n\n\`\`\`ts\nexport const answer = 42\n\`\`\`\n\n\`\`\`vibe\n${body}\`\`\`\n`
  const test = `import { answer } from "../examples/quickstart.vibe"\n`

  it("passes a page that shows the example verbatim beside a test that imports it", () => {
    expect(DocsParity.exampleProblem(example, { page: page(source), example: source, test })).toBeUndefined()
    expect(DocsParity.exampleProblem(example, {
      page: page(source).replaceAll("\n", "\r\n"),
      example: `${source}\n\n`,
      test: test.replaceAll("\"", "'")
    })).toBeUndefined()
  })

  it("names the page when it has no fence in the example's language", () => {
    expect(
      DocsParity.exampleProblem(example, { page: "```ts\nexport const answer = 42\n```\n", example: source, test })
    )
      .toBe("packages/a/docs/quickstart.md has no `vibe` fence; paste packages/a/examples/quickstart.vibe into one")
  })

  it("refuses a fence that drifted from the example", () => {
    expect(DocsParity.exampleProblem(example, { page: page("export const answer = 41\n"), example: source, test }))
      .toBe(
        "no `vibe` fence in packages/a/docs/quickstart.md matches packages/a/examples/quickstart.vibe; paste the file again"
      )
  })

  it("refuses a test that does not import the example", () => {
    expect(
      DocsParity.exampleProblem(example, { page: page(source), example: source, test: "import \"./other.vibe\"\n" })
    )
      .toBe(
        "packages/a/test/quickstart.test.vibe does not import ../examples/quickstart.vibe, " +
          "so no test runs the example packages/a/docs/quickstart.md shows"
      )
  })

  it("spells a same-directory import with a leading ./", () => {
    const beside = { ...example, test: "packages/a/examples/quickstart.test.vibe" }
    expect(
      DocsParity.exampleProblem(beside, { page: page(source), example: source, test: "import \"./quickstart.vibe\"\n" })
    )
      .toBeUndefined()
  })
})

describe("DocsParity", () => {
  const target = DocsParity.DocsParity({
    readme: { _tag: "File", path: "README.md" },
    deps: [],
    cwd: "packages/smithers/flows/plan"
  })

  it("participates in the docs verb alone, never in build, test, or lint", () => {
    expect(Target.metadata(target).kinds).toEqual(["docs"])
    expect(DocsParity.DocsParity.kinds).toEqual(["docs"])
  })

  it("declares the README as a build input so editing it re-keys the target", () => {
    expect(Target.metadata(target).inputs).toContainEqual({ _tag: "File", path: "README.md" })
  })

  it("declares each page example's page, source, and test as inputs and passes them to the check", () => {
    const withExample = DocsParity.DocsParity({
      readme: { _tag: "File", path: "README.md" },
      deps: [],
      examples: [{
        page: { _tag: "File", path: "docs/quickstart.md" },
        example: { _tag: "File", path: "examples/quickstart.vibe" },
        test: { _tag: "File", path: "test/quickstart.test.vibe" }
      }],
      cwd: "packages/errors"
    })
    const metadata = Target.metadata(withExample)
    for (const path of ["docs/quickstart.md", "examples/quickstart.vibe", "test/quickstart.test.vibe"]) {
      expect(metadata.inputs).toContainEqual({ _tag: "File", path })
    }
    expect(plannedCalls(withExample)[0]?.payload["examples"]).toEqual([{
      page: "packages/errors/docs/quickstart.md",
      example: "packages/errors/examples/quickstart.vibe",
      test: "packages/errors/test/quickstart.test.vibe"
    }])
    expect((Target.metadata(target).attrs as DocsParity.Attrs).examples).toEqual([])
    expect(plannedCalls(target)[0]?.payload).not.toHaveProperty("examples")
  })

  it("defaults the prose floor and stays cacheable", () => {
    const metadata = Target.metadata(target)
    expect((metadata.attrs as DocsParity.Attrs).minimumProseCharacters).toBe(
      DocsParity.defaultMinimumProseCharacters
    )
    expect(metadata.cacheable).toBe(true)
  })

  it("refuses a prose floor that would let an empty body pass", () => {
    expect(() =>
      DocsParity.DocsParity({
        readme: { _tag: "File", path: "README.md" },
        deps: [],
        minimumProseCharacters: 0,
        cwd: "packages/smithers/flows/plan"
      })
    ).toThrow()
    expect(() =>
      DocsParity.DocsParity({
        readme: { _tag: "File", path: "README.md" },
        deps: [],
        minimumProseCharacters: DocsParity.maximumReadmeBytes + 1,
        cwd: "packages/smithers/flows/plan"
      })
    ).toThrow()
  })
})

describe("DocsParity execution", () => {
  it("confines and bounds README reads", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-read-")))
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-outside-")))
    const request = (path: string) =>
      DocsParity.checkDocs(
        { workspaceRoot: root },
        { path, minimumProseCharacters: 1 }
      )
    const failed = (path: string) =>
      Effect.runPromise(
        Effect.flip(request(path).pipe(Effect.mapError((error) => ({ message: error.message }))))
      )
    try {
      expect((await failed("../README.md")).message).toContain("escapes the workspace")
      await Fs.writeFile(NodePath.join(root, "large.bin"), Buffer.alloc(DocsParity.maximumReadmeBytes + 1, 0x20))
      expect((await failed("large.bin")).message).toContain(`larger than ${DocsParity.maximumReadmeBytes} bytes`)
      await Fs.writeFile(NodePath.join(outside, "README.md"), "# outside\n\nEnough prose.\n", "utf8")
      await Fs.symlink(NodePath.join(outside, "README.md"), NodePath.join(root, "README.md"))
      expect((await failed("README.md")).message).toContain("leaving the workspace")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("reads each page example from the workspace and reports what is missing or drifted", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-example-")))
    const write = (relative: string, text: string) =>
      Fs.mkdir(NodePath.dirname(NodePath.join(root, relative)), { recursive: true }).then(() =>
        Fs.writeFile(NodePath.join(root, relative), text, "utf8")
      )
    const example = {
      page: "p/docs/quickstart.md",
      example: "p/examples/quickstart.vibe",
      test: "p/test/quickstart.test.vibe"
    }
    const check = (examples?: ReadonlyArray<DocsParity.ExamplePayload>) =>
      Effect.runPromise(
        Effect.result(DocsParity.checkDocs({ workspaceRoot: root }, {
          path: "p/README.md",
          minimumProseCharacters: 1,
          ...(examples === undefined ? {} : { examples })
        })).pipe(Effect.map((result) => result._tag === "Success" ? "ok" : result.failure.message))
      )
    try {
      await write("p/README.md", "# p\n\nProse.\n")
      expect(await check()).toBe("ok")
      expect(await check([example])).toBe("the documentation page p/docs/quickstart.md does not exist")
      await write("p/docs/quickstart.md", "```vibe\nexport const a = 1\n```\n")
      expect(await check([example])).toBe("the page example p/examples/quickstart.vibe does not exist")
      await write("p/examples/quickstart.vibe", "export const a = 2\n")
      expect(await check([example])).toBe("the example test p/test/quickstart.test.vibe does not exist")
      await write("p/test/quickstart.test.vibe", "import { a } from \"../examples/quickstart.vibe\"\n")
      expect(await check([example])).toContain("matches p/examples/quickstart.vibe")
      await write("p/examples/quickstart.vibe", "export const a = 1\n")
      expect(await check([example])).toBe("ok")
      expect(await check([{ ...example, page: "../outside.md" }])).toContain("escapes the workspace")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("runs passing checks and reports failing packages and drifted examples across //...", async () => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-parity-"))
    const write = async (relative: string, text: string): Promise<void> => {
      const path = NodePath.join(root, relative)
      await Fs.mkdir(NodePath.dirname(path), { recursive: true })
      await Fs.writeFile(path, text, "utf8")
    }
    try {
      const rulesModule = JSON.stringify(new URL("../src/Smithers.ts", import.meta.url).href)
      await write(
        ".smithers/WORKSPACE.ts",
        `import * as S from ${rulesModule}\n` +
          `const packageJson = S.file("//package.json")\n` +
          `export const Workspace = S.Workspace("fixture", {\n` +
          `  repository: "git+https://example.invalid/fixture.git",\n` +
          `  cache: S.Cache({ directory: ".flows" }),\n` +
          `  runtime: S.Runtime.Node({ version: "26" }),\n` +
          `  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),\n` +
          `  nodeModules: S.Npm.NodeModules({ packageJson })\n` +
          `})\n`
      )
      await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
      await write("yarn.lock", "# yarn lockfile v1\n")
      for (const name of ["complete", "stub", "drifted"]) {
        const examples = name === "stub" ?
          "" :
          `, examples: [{ page: S.file("docs/quickstart.md"), example: S.file("examples/quickstart.vibe"), ` +
          `test: S.file("test/quickstart.test.vibe") }]`
        await write(
          `packages/${name}/PACKAGE.ts`,
          `import * as S from ${rulesModule}\n` +
            `const runtime = S.Runtime.Node({ version: ">=26.4.0" })\n` +
            `const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })\n` +
            `const docs = S.DocsParity({ readme: S.file("README.md"), deps: [], cwd: "packages/${name}"${examples} })\n` +
            `export const Package = S.Package({ targets: { docs } })\n`
        )
      }
      for (const name of ["complete", "drifted"]) {
        await write(
          `packages/${name}/README.md`,
          `# ${name}\n\n` +
            "This package description is intentionally long enough to establish the package contract, " +
            "its role in the workspace, and the behavior consumers can rely on when they call it.\n"
        )
        await write(`packages/${name}/docs/quickstart.md`, "```vibe\nexport const answer = 42\n```\n")
        await write(
          `packages/${name}/test/quickstart.test.vibe`,
          `import { answer } from "../examples/quickstart.vibe"\n`
        )
      }
      await write("packages/complete/examples/quickstart.vibe", "export const answer = 42\n")
      await write("packages/drifted/examples/quickstart.vibe", "export const answer = 41\n")
      await write("packages/stub/README.md", "# stub\n\n[reference]: https://example.com/not-prose\n")

      const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
      const summary = await PackageExec.run({
        index: PackageIndex.make(loaded, root),
        cacheDirectory: ".flows",
        verb: "docs",
        patterns: ["//..."],
        jobs: 2,
        readCache: false,
        log: () => {}
      })

      expect("ok" in summary && summary.ok).toBe(false)
      if (!("results" in summary)) throw new Error("docs execution returned a plan")
      const complete = summary.results.find((entry) => entry.label === "//packages/complete:docs")
      expect(complete?.status, JSON.stringify(complete)).toBe("ran")
      expect(summary.results.find((entry) => entry.label === "//packages/stub:docs")?.status).toBe("failed")
      expect(summary.results.find((entry) => entry.label === "//packages/drifted:docs")?.status).toBe("failed")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
