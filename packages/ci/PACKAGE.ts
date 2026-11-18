import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/ci"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  // test/docs.test.ts reads the docs pages and the splash page; test/cli runs bin/ and test/cli/program.mjs;
  // test/closure/zig copies and builds the Zig project under test/fixtures/closure-zig.
  testData: [
    "docs/**/*.md",
    "docs/splash/index.html",
    "bin/*.mjs",
    "test/**/*.mjs",
    "test/fixtures/*.json",
    "test/fixtures/closure-zig/**"
  ],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
