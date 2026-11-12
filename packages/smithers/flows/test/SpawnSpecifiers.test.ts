/**
 * What the guarded-spawn gate can and cannot see.
 *
 * The gate's whole subject is the bypass nobody has written yet, which makes
 * it the one check in this repository that the tree cannot exercise: nothing
 * under `packages/*\/src` spells most of these forms today, so a reader that
 * missed one would look exactly like a reader that works, right up to the day
 * someone writes it. Three regex versions of the reader shipped looking
 * exactly like that, and each was one layout wide.
 *
 * So every layout is a FIXTURE FILE, written to a temporary directory and read
 * back through the same walk-and-parse path the real scan uses. The files are
 * written rather than committed on purpose: `dprint` formats everything in
 * this repository, including tests, and the formatter is what produced the
 * bypass in the first place. A committed multi-line fixture short enough to
 * fit on one line would be collapsed to one line by the next `dprint fmt`, and
 * the layout it exists to pin would silently stop being tested.
 *
 * `legacyRegex` below is the reader as it stood at `5370016971`, kept so the
 * gap is stated as a fact rather than as history: it names, executably, every
 * layout that shipped unguarded.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { bindsSpawningModule, collectSources, fileBindsSpawningModule, sourceExtensions } from "./SpawnSpecifiers.ts"

/**
 * The reader as it stood at `5370016971`, verbatim.
 *
 * Three text patterns over the raw source: a single-line static import, a
 * parenthesized dynamic `import`, and a parenthesized `require`.
 */
const legacyRegex = (source: string): boolean => {
  const specifier = String.raw`["'](?:node:)?(?:child_process|cluster)["']`
  return new RegExp(String.raw`^\s*import\s[^\n]*?from\s*${specifier}`, "m").test(source)
    || new RegExp(String.raw`\bimport\s*\(\s*${specifier}\s*\)`).test(source)
    || new RegExp(String.raw`\brequire\s*\(\s*${specifier}\s*\)`).test(source)
}

/** A layout that binds a process-starting module, and the file it lives in. */
const binding: ReadonlyArray<{ readonly file: string; readonly source: string }> = [
  { file: "single-line.ts", source: `import { spawn } from "node:child_process"\n` },
  {
    // What `dprint` produces for an import over 120 characters, which is the
    // layout a bypass is most likely to arrive in: 54 declarations in this
    // tree are already spelled this way.
    file: "multi-line.ts",
    source: `import {\n`
      + `  exec,\n  execFile,\n  execFileSync,\n  execSync,\n  fork,\n  spawn,\n  spawnSync\n`
      + `} from "node:child_process"\n`
  },
  { file: "bare-specifier.ts", source: `import { spawn } from "child_process"\n` },
  { file: "default-import.ts", source: `import spawner from "child_process"\n` },
  { file: "namespace-import.mts", source: `import * as ChildProcess from "node:child_process"\n` },
  {
    file: "type-only-import.tsx",
    source: `import type { ChildProcess } from "node:child_process"\n`
      + `export const View = () => <div>{"child" as unknown as ChildProcess extends never ? 1 : 2}</div>\n`
  },
  { file: "side-effect-import.mjs", source: `import "node:child_process"\n` },
  { file: "export-from.ts", source: `export { spawn } from "node:child_process"\n` },
  { file: "export-star.ts", source: `export * from "node:cluster"\n` },
  { file: "cluster-fork.js", source: `import { fork } from "cluster"\n\nfork()\n` },
  { file: "dynamic-import.ts", source: `const spawner = await import("node:child_process")\n` },
  {
    file: "dynamic-import-attributes.ts",
    source: `const spawner = await import("node:child_process", { with: {} })\n`
  },
  { file: "dynamic-import-template.mjs", source: "const spawner = await import(`node:child_process`)\n" },
  { file: "require.cjs", source: `const spawner = require("node:child_process")\n` },
  {
    file: "create-require.mjs",
    source: `import { createRequire } from "node:module"\n\n`
      + `const spawner = createRequire(import.meta.url)("node:child_process")\n`
  },
  { file: "get-builtin-module.ts", source: `const spawner = process.getBuiltinModule("node:child_process")\n` },
  { file: "import-equals.cts", source: `import spawner = require("child_process")\nspawner.spawn("ls")\n` },
  { file: "import-type-node.ts", source: `let spawner: typeof import("node:child_process")\n` },
  {
    // The comment-stripping reader drafted to replace the first regex read
    // this as one comment, from the `/*` in the string to the `*/` two lines
    // down, and the import between them disappeared.
    file: "after-string-holding-a-comment-opener.ts",
    source: `const glob = "/*"\nimport { spawn } from "node:child_process"\nconst end = "*/"\n`
  },
  {
    // Same reader, other half: the `//` inside the URL was read as the start
    // of a line comment, so everything after it on that line was blanked, the
    // dynamic import included.
    file: "after-string-holding-a-line-comment.ts",
    source: `export const load = (from = "https://example.test") => import("node:child_process")\n`
  },
  {
    // Nothing says the bypass sits at the top of the file.
    file: "nested-in-a-callback.jsx",
    source: `export const View = () => <button onClick={() => import("node:child_process")}>go</button>\n`
  },
  { file: "vibelang-import.vibe", source: `import { spawn } from "node:child_process"\n` },
  {
    // VibeLang's own forms, which the reader parses as their TypeScript
    // projection rather than as written.
    file: "inside-an-effect-function.vibe",
    source: `export effect function load() {\n  return try Effect.promise(() => import("node:child_process"))\n}\n`
  },
  {
    file: "vibelang-component.vibex",
    source: `export const View = () => <button onClick={() => require("cluster")}>go</button>\n`
  }
]

/** A layout that names a process-starting module without binding it. */
const inert: ReadonlyArray<{ readonly file: string; readonly source: string }> = [
  {
    file: "prose-doc-comment.ts",
    source: `/**\n * Resolves the tag instead of node:child_process.\n */\nexport const a = 1\n`
  },
  {
    // A module that quotes the line it is warning against must stay clean, or
    // the gate teaches authors to describe the boundary less clearly.
    file: "prose-quoting-the-import.ts",
    source: `/**\n * Never \`import { spawn } from "node:child_process"\`.\n */\nexport const b = 2\n`
  },
  { file: "prose-line-comment.ts", source: `// never child_process, always the tag\nexport const c = 3\n` },
  { file: "worker-threads.ts", source: `import { Worker } from "node:worker_threads"\n\nexport const d = Worker\n` },
  { file: "specifier-in-a-plain-string.ts", source: `export const name = "node:child_process"\n` },
  { file: "lookalike-package.ts", source: `import shim from "child_process-shim"\n\nexport const e = shim\n` },
  { file: "plain-component.tsx", source: `export const View = () => <div>nothing here</div>\n` },
  {
    file: "vibelang-prose.vibe",
    source: `// never node:child_process, always the tag\nexport effect function f() {\n  return 1\n}\n`
  }
]

/** Layouts the reader at `5370016971` could not see. */
const missedByTheLegacyRegex = [
  "create-require.mjs",
  "dynamic-import-attributes.ts",
  "dynamic-import-template.mjs",
  "export-from.ts",
  "export-star.ts",
  "get-builtin-module.ts",
  "multi-line.ts",
  "side-effect-import.mjs"
]

/**
 * The reader that was drafted to replace `legacyRegex`, verbatim.
 *
 * It answers the layout problem by asking WHERE the specifier sits instead of
 * how the import is written, over a copy of the source with comments removed
 * so prose stays unflagged. Removing comments with a regex is the part that
 * does not work: the comment syntax it strips also occurs inside string
 * literals, and a parser is the only thing that can tell the two apart.
 */
const strippedCommentsRegex = (source: string): boolean => {
  const specifier = "[\"'`](?:node:)?(?:child_process|cluster)[\"'`]"
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
  return new RegExp(String.raw`\bfrom\s*${specifier}`).test(code)
    || new RegExp(String.raw`\(\s*${specifier}\s*[),]`).test(code)
    || new RegExp(String.raw`^\s*import\s*${specifier}`, "m").test(code)
}

/** Layouts the comment-stripping reader could not see. */
const missedByTheStrippedCommentsRegex = [
  "after-string-holding-a-comment-opener.ts",
  "after-string-holding-a-line-comment.ts"
]

describe("reading spawn bindings from the syntax tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "flows-spawn-specifiers-"))
  for (const { file, source } of [...binding, ...inert]) writeFileSync(join(directory, file), source)

  it.each(binding.map(({ file }) => ({ file })))("sees the binding in $file", ({ file }) => {
    expect(fileBindsSpawningModule(join(directory, file))).toBe(true)
  })

  it.each(inert.map(({ file }) => ({ file })))("leaves $file alone", ({ file }) => {
    expect(fileBindsSpawningModule(join(directory, file))).toBe(false)
  })

  it("walks every extension a module in this repository can be written in", () => {
    // The fixtures span the whole extension list on purpose: a walk narrowed
    // back to `.ts` un-scans the 86 `.tsx` components and the two `.js` entry
    // points under `packages/*/src`, and would fail here rather than silently.
    const walked = collectSources(directory).map((path) => basename(path))
    expect(walked).toEqual([...binding, ...inert].map(({ file }) => file).sort())
    for (const extension of sourceExtensions) {
      expect(walked.some((file) => file.endsWith(extension)), extension).toBe(true)
    }
  })

  it("walks nothing for a directory that does not exist", () => {
    expect(collectSources(join(directory, "absent"))).toEqual([])
  })

  it("sees layouts the regex it replaced walked straight through", () => {
    // The point of the parser, stated as a fact rather than as history. Every
    // name here is a real way to bind the module that the shipped gate at
    // `5370016971` reported as clean.
    const missed = binding
      .filter(({ source }) => !legacyRegex(source))
      .map(({ file }) => file)
      .sort()
    expect(missed).toEqual([...missedByTheLegacyRegex].sort())
    for (const { file, source } of binding) {
      expect(bindsSpawningModule(source, file), file).toBe(true)
    }
  })

  it("sees layouts a comment-stripping regex loses inside string literals", () => {
    // The draft that answered the layout problem regressed two cases the
    // shipped regex caught, which is the whole argument for a parser: every
    // text reader trades one blind spot for another.
    const missed = binding
      .filter(({ source }) => !strippedCommentsRegex(source))
      .map(({ file }) => file)
      .sort()
    expect(missed).toEqual([...missedByTheStrippedCommentsRegex].sort())
  })

  it("reads a `.tsx` module as TSX", () => {
    // A `.tsx` file parsed as `.ts` loses its elements to a type-assertion
    // ambiguity and takes the imports above them down with it, so the script
    // kind is load-bearing rather than tidy.
    const source = `import { spawn } from "node:child_process"\nexport const View = () => <div>{spawn.name}</div>\n`
    expect(bindsSpawningModule(source, "View.tsx")).toBe(true)
  })

  it("defaults to TypeScript when no path is given", () => {
    expect(bindsSpawningModule(`import { spawn } from "node:child_process"\n`)).toBe(true)
  })

  afterAll(() => rmSync(directory, { recursive: true, force: true }))
})
