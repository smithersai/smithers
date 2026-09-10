import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory. The targets
 * declared here are what `smthrs ci '//packages/...'` plans for this package;
 * the generated `.github/workflows/ci.yml` runs that label and names no
 * package, so a package with no `PACKAGE.ts` has no typecheck, suite, or lint
 * in CI.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/std"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
