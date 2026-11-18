import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/ci"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  // test/docs.test.ts reads the docs pages and the splash page.
  testData: ["docs/**/*.md", "docs/splash/index.html"],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
