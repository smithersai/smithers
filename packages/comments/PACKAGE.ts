import { BuildAndCheckTypeScriptPackage, WorkspaceSources } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/comments"

const sources = WorkspaceSources({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  reads: [...Object.values(sources)],
  testData: [
    "docs/**/*.md",
    "docs/splash/index.html",
    "bin/*.mjs",
    "dprint.json",
    "README.md",
    "vitest.config.ts"
  ],
  cwd
})

const bench = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.benchmark.test.ts")],
  sources: [
    Smithers.glob("src/**/*.{ts,vibe}"),
    Smithers.glob("test/**/*.{ts,vibe}"),
    Smithers.file("tsconfig.json"),
    Smithers.file("tsconfig.test.json"),
    Smithers.file("vitest.benchmark.config.ts")
  ],
  deps: [lib, ...Object.values(sources)],
  config: Smithers.file("vitest.benchmark.config.ts"),
  environment: "node",
  coverage: false,
  exclusive: true,
  passWithNoTests: false,
  timeoutMs: 300_000,
  cwd
})

export const Package = Smithers.Package({
  targets: {
    bench,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    ...sources
  }
})
