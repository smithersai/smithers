/**
 * Targets for the repository-contract gates.
 *
 * They live in their own directory, and their own BUILD file, because they are
 * about the workspace rather than about any package in it: the version line,
 * the publishable surface, the barrels, and the fault matrix's own discipline.
 * `//scripts/...` is recursive, so the whole set stays under the one pattern the
 * pipeline already runs.
 *
 * The interpreter comes from the root runtime declaration. Nothing here spells
 * `node`.
 */
import { Smithers } from "@smthrs/targets"
import { Package as sitePackage } from "../../apps/site/PACKAGE.ts"

/** Every gate in this directory, digested as the input of each target. */
const sources = Smithers.glob("//scripts/repo-contract/**/*.mjs")

/**
 * One version across the release line, a declared publishable surface, and the
 * scripts every other gate invokes.
 *
 * The manifests it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless, which is correct: its subject
 * is the whole workspace.
 *
 * @since 1.0.0
 * @category test
 */
const packageContract = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/package-contract.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Explicit entrypoints preserve reviewed imports and block future source files.
 * @since 1.0.0
 * @category test
 */
const publicExportMaps = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/public-export-maps.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/public-export-map.mjs"),
    Smithers.file("//scripts/fixtures/public-export-surface.json"),
    Smithers.file("//scripts/workspace-packages.mjs"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

/**
 * The barrels re-export what they claim, checked by importing them.
 *
 * A typecheck reads the same source the declarations are generated from, so it
 * cannot catch a re-export that was never written. Loading the module can.
 *
 * @since 1.0.0
 * @category test
 */
const barrels = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/barrels.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every workspace member with tests is reachable from the command CI runs.
 *
 * @since 1.0.0
 * @category test
 */
const testScriptWiring = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/test-script-wiring.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/check-signal-campaign.mjs"),
    Smithers.file("//scripts/release-rehearsal.mjs"),
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//scripts/PACKAGE.ts"),
    Smithers.file("//scripts/repo-contract/PACKAGE.ts"),
    Smithers.glob("//scripts/**/*.test.mjs"),
    Smithers.glob("//factory/**/*.test.ts"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//.github/workflows/reliability.yml"),
    Smithers.file("//apps/ui/PACKAGE.ts"),
    Smithers.file("//apps/ui/scripts/ensure-devkit.mjs"),
    Smithers.file("//apps/ui/scripts/run-pr-e2e.mjs"),
    Smithers.file("//apps/ui/package.json"),
    Smithers.file("//apps/ui/electrobun.config.ts"),
    Smithers.file("//apps/ui/hutch.config.ts"),
    Smithers.file("//apps/ui/tsconfig.json"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

/**
 * No focused or parked test in the fault matrix, every conditional skip
 * declared with its reason, and every package that carries fault cases wired to
 * a target that runs them.
 *
 * The coverage record the suite reads is an input beside the gates themselves:
 * a required red gate names a row in `fault-gaps.md`, so editing that row has
 * to re-key this target.
 *
 * @since 1.0.0
 * @category test
 */
const faultSkips = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/fault-skips.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/repo-contract/fault-gaps.md")],
  deps: []
})

/**
 * No operator rig under `evals/`, `scripts/`, or a package's `test/faults` tree
 * names one machine's home directory.
 *
 * @since 1.0.0
 * @category test
 */
const machinePaths = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/machine-paths.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every smithers.sh URL shipped by a package reaches the built documentation,
 * directly or through one production redirect whose destination is real.
 *
 * The route oracle is the emitted HTML under `apps/site/dist`, so the site's
 * build is a dependency rather than a step someone ran first. The edge orders
 * the build ahead of the gate, keys the gate on the build's own key so a
 * content change re-runs it, and puts the build's declared outputs in the
 * gate's sandbox read set. It is a selector rather than an import because
 * importing `apps/site/PACKAGE.ts` would pull every documented package's
 * declaration into this file to reach one target.
 *
 * `dist` is deliberately not declared as an input: declared inputs expand at
 * plan time, and on a clean checkout the directory the build has not produced
 * yet expands to nothing, which is both a vacuous edge and no read at all.
 *
 * @since 1.0.0
 * @category test
 */
const smithersLinks = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/smithers-links.test.mjs")]),
  srcs: [sources],
  deps: [sitePackage.build]
})

/**
 * The reference indexes every canonical command, retains the compatibility
 * pages, and describes flags accepted by the public parser. The generated
 * manifest and help have their own executable drift gate.
 *
 * @since 1.0.0
 * @category test
 */
const cliVerbs = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/cli-verbs.test.mjs")]),
  srcs: [sources],
  deps: []
})
/**
 * Actual planner selection, runtime policy, sentinels and cache behavior.
 * Finish the script graph's in-tree builds before starting fresh discovery:
 * replacing a dist directory during its confined read correctly refuses it.
 * These are execution dependencies, so clean checkouts need no existing dist.
 */
const ciInventory = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/ci-inventory.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/ci-inventory.mjs")],
  deps: [Smithers.Target.subtree("//packages/...", "lib"), sitePackage.build]
})

export const Package = Smithers.Package({
  targets: { barrels, cliVerbs, faultSkips, machinePaths, packageContract, smithersLinks, testScriptWiring, ciInventory, publicExportMaps }
})
