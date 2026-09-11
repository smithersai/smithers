import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { readWorkspaceInventory } from "../readWorkspaceInventory.ts"

describe("ci conformance", () => {
  it("keeps cache write credentials out of every pull-request job", () => {
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
    assert.doesNotMatch(ci, /secrets\.SMITHERS_CACHE_TOKEN\b/)
    const jobs = ci.split("\njobs:\n")[1]!.split(/\n(?= {2}\S)/)
    const publishers = jobs.filter((job) => job.includes("secrets.SMITHERS_CACHE_WRITE_TOKEN"))
    assert.equal(publishers.length, 1)
    assert.match(publishers[0]!, /^ {2}cache-publish:/)
    assert.match(publishers[0]!, /^ {4}if: \$\{\{ github.event_name == 'push' && github.ref == 'refs\/heads\/main' \}\}$/m)
    for (const job of jobs) {
      for (const step of job.split(/\n(?= {6}- )/).slice(1)) {
        if (!step.includes("run: pnpm exec smthrs")) continue
        assert.match(step, /SMITHERS_CACHE_READ_TOKEN: "\$\{\{ secrets\.SMITHERS_CACHE_READ_TOKEN \}\}"/)
        if (job === publishers[0]) continue
        assert.doesNotMatch(step, /SMITHERS_CACHE_WRITE_TOKEN|SMITHERS_CACHE_TOKEN/)
        assert.match(step, /SMITHERS_CACHE_NAMESPACE: "\$\{\{ github.event_name == 'pull_request' && format\('pr-\{0\}', github.event.pull_request.number\) \|\| '' \}\}"/)
      }
    }
    const release = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")
    assert.match(release, /secrets\.SMITHERS_CACHE_READ_TOKEN/)
    assert.doesNotMatch(release, /SMITHERS_CACHE_(?:WRITE_)?TOKEN/)
    const workspace = readFileSync(new URL("../../.smithers/WORKSPACE.ts", import.meta.url), "utf8")
    assert.match(workspace, /read: S.Secret\("SMITHERS_CACHE_READ_TOKEN"\)/)
    assert.match(workspace, /write: S.Secret\("SMITHERS_CACHE_WRITE_TOKEN"\)/)
  })

  const { packagesDir, packages } = readWorkspaceInventory()
  for (const entry of packages.map((name) => ({ name }))) {
    it(`${entry.name} retains a real Vitest test script (issue #158)`, () => {
      const { name } = entry

      // The recursive developer entry point must retain the package's own
      // config and coverage gate. CI selects PACKAGE.ts test targets; its
      // actual pattern and target runner are checked separately.
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly scripts?: Record<string, string>
      }
      assert.match((manifest.scripts?.test)!, /^vitest(?: run)?$/, `packages/${name}/package.json scripts.test`)
    })
  }

  it("pins the root workspaces globs to the conformance universe (issue #154)", () => {
    // The universe above is derived from `packages/`; that is complete only
    // while `packages/*` is the WHOLE workspace. A second glob (`apps/*`)
    // would ship its packages with no coverage gate at all while every cell
    // here stayed green — the #148 defect reinstated silently. Adding a
    // workspace root means widening this assertion AND the universe
    // derivation above, in review.
    //
    // Widened once, deliberately: `examples` is a private, unpublished
    // workspace of runnable documentation programs. It ships no `src` tree
    // and no coverage gate, and the universe derivation above still reads
    // `packages/` only, so it adds no ungated publishable surface. It is a
    // workspace so its end-to-end suite resolves the real `@smthrs/*`
    // packages and runs under the root `pnpm test` fan-out.
    // Widened a second time, deliberately (2026-08-15, smithers build absorption):
    // `packages/smithers/build/infra` is the hosted cache Cloudflare Worker that ships
    // inside the `smithers-build` package. It is private and unpublished, and it is a
    // workspace member only so its own vitest suite and `tsc --noEmit` run under
    // the root fan-out instead of being dead code. It is NESTED under
    // `packages/smithers/build`, so the `packages/` universe derivation above — which
    // reads top-level directories only — is unaffected and no top-level
    // publishable surface escapes the gate. `sharp` and `workerd` are its
    // wrangler toolchain's postinstall builds, denied like every other.
    // Narrowed again: `e2e` was the fault-injection matrix, widened into this
    // roster by release gate B6 because it was not a member, had no
    // `node_modules`, and `//e2e:faults` failed in 262 ms with
    // `Command "vitest" not found` — eighteen crash, restart, gateway,
    // time-travel, provider, and safety cases that had never run under any
    // gate. Membership is not what a case needs any more: every one of them
    // now lives in the package whose behaviour it asserts, under
    // `test/faults`, where the package's own `node_modules`, `check`, and
    // `faults` target already reach it. `//packages/...:faults` is the matrix.
    // Widened a third time for the deployable applications. `apps/*` contains
    // private entry points rather than published library packages; each app's
    // own test/build scripts participate in the root recursive gates, while
    // the package publication/coverage universe remains `packages/*`.
    // Widened a fifth time: `evals/*` are the evaluation suites. Each one now
    // carries its own private manifest and pins its own `typescript` and
    // `@types/node` instead of resolving whatever the root install hoisted.
    // They are private, unpublished, ship no `src` tree, and sit outside the
    // `packages/` universe derivation above, so they add no ungated
    // publishable surface.
    //
    // Widened a sixth time, and this one adds no surface: `packages/smithers/flows/canonical`
    // is `@smthrs/canonical` nested inside the product package it belongs to, so
    // the hierarchy is visible in the tree. It publishes the same name at the same
    // version to the same dist-tag, and the universe derivation above descends, so
    // it is still held to every assertion here. Membership is spelled out rather
    // than widened to `packages/*/*`: that glob names directories that are not
    // packages, and the gates that read this list one directory deep would stop
    // covering nested members without failing.
    //
    // Widened a seventh time (2026-09-06, release workflows restored): `flows`
    // is `@smithers/release-workflows`, the private, unpublished workspace of
    // the repository's own Smithers programs (release, review, triage, the
    // release-support CLI the root `release:*` scripts call). It ships no
    // `src` tree, is never published, and sits outside the `packages/`
    // universe derivation above, so it adds no ungated publishable surface. It
    // is a member so its `check` and `test` run under the root fan-out and so
    // it resolves the real `@smthrs/*` packages through workspace links.
    const workspace = readFileSync(join(packagesDir, "..", "pnpm-workspace.yaml"), "utf8")
    const packagesBlock = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.equal(
      packagesBlock,
      [
        "packages:",
        "  - \"packages/*\"",
        "  - \"packages/smithers/*\"",
        "  - \"packages/smithers/agent/*\"",
        "  - \"packages/smithers/build/*\"",
        "  - \"packages/smithers/flows/*\"",
        "  - \"packages/smithers/ui/*\"",
        "  - \"examples\"",
        "  - \"flows\"",
        "  - \"apps/*\"",
        "  - \"apps/docs/*\"",
        "  - \"evals/*\"",
        ""
      ].join("\n")
    )

    // The allowBuilds roster is a supply-chain control, not formatting: each
    // entry denies a dependency's postinstall build, and `playwright` is the
    // clearest case — its postinstall downloads browsers, while the live-*
    // checks run against an already-installed one. Denying a build removes
    // ungated surface rather than adding it.
    //
    // This block is asserted on its own rather than as part of an exact match
    // over the whole file. Pinning the entire file made every unrelated
    // addition (`minimumReleaseAgeExclude`, for one) look like a failure here,
    // which is what pressured an earlier change into dropping the roster from
    // the assertion altogether. Flipping any entry to `true` must fail a gate.
    const allowBuilds = workspace.match(/^allowBuilds:\n(?:  .+\n)+/m)?.[0]
    assert.equal(
      allowBuilds,
      [
        "allowBuilds:",
        "  \"@journeyapps/wa-sqlite\": false",
        "  core-js: false",
        "  dprint: false",
        "  es5-ext: false",
        "  esbuild: false",
        "  msgpackr-extract: false",
        "  playwright: false",
        "  sharp: false",
        "  unrs-resolver: false",
        "  vue-demi: false",
        "  workerd: false",
        ""
      ].join("\n")
    )
    assert.match(workspace, /^linkWorkspacePackages: true$/m)
    assert.match(workspace, /^verifyDepsBeforeRun: false$/m)
  })

  it("pins the root aggregator scripts CI invokes (issue #166)", () => {
    // The per-package `scripts.test` pin (issue #158) covered the leaves but
    // not the root: CI runs `pnpm test`, and the root aggregator is what fans
    // that out across every workspace. Narrowing it — e.g. to
    // `--workspace packages/smithers/flows` — silently dropped siblings from CI while
    // every per-package cell and the workspaces-glob cell stayed green. The
    // exact aggregator bodies are pinned here; changing how CI fans out
    // means widening this assertion in review.
    //
    // `test:examples` is a named alias for the examples workspace only. The
    // root `test` fan-out already reaches it, so the alias is a documentation
    // entry point rather than a second enforcement path.
    //
    // `deploy:dry` is the same shape: a single-workspace alias for the server
    // app's deploy rehearsal. It is not a gate CI fans out, so it neither adds
    // nor removes enforcement — it is pinned only so the roster stays exact.
    //
    // `dev` is a developer entry point, not a gate: it forwards to the UI
    // workspace's `start` (devkit projection, `vite build --configLoader
    // runner`, `electrobun dev`) so the Electrobun launch lives in one place.
    // `checklist` forwards the UI acceptance checks. `dev` runs nothing in
    // CI and fans nothing out.
    //
    // `test:jsdoc` is the root-level contract for the repository's custom
    // JSDoc rule harness; pinning it here keeps that non-workspace gate from
    // appearing or disappearing without conformance review.
    //
    // `lint:jsdoc` is the operator alias for CI's `//:jsdocTree`: it enforces
    // public-export JSDoc across all three package depths with the root config.
    // Keep its source globs aligned with the target below.
    //
    // `test:e2e` is the macOS developer entry point for the packaged
    // Electrobun lane. It builds a stable bundle and drives that bundle with
    // Bun; CI does not invoke it because the package graph has no macOS host.
    //
    // `check:npm-dedupe` is the operator alias for `//scripts:npmDedupe`, the
    // same shape as `browser` and `//scripts:browserContract`. The resolution reads
    // registry metadata, so the target is uncacheable and re-runs regardless,
    // which is the only concession the network costs. The alias is pinned so
    // the roster stays exact, not because it is a second enforcement path.
    //
    // `release:*` are operator entry points into the `flows` workspace's
    // release-support program (release.yml and release-auth.yml call the same
    // module). They run nothing in CI's package-graph gates and fan nothing
    // out, so they neither add nor remove enforcement; they are pinned so the
    // roster stays exact.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>
    }
    assert.deepEqual(root.scripts, {
      browser: "node scripts/browser-check.mjs",
      check: "pnpm --recursive --if-present run check",
      checklist: "pnpm --filter smithers-app run checklist",
      "check:npm-dedupe": "node scripts/check-npm-dedupe.mjs",
      circular: "pnpm --recursive --if-present run circular",
      "deploy:dry": "pnpm --filter smithers-server run deploy:dry",
      "docs:build": "pnpm --filter \"@smithers/docs-*\" --filter \"!@smithers/docs-shared\" -r run build",
      "docs:check":
        "node apps/docs/shared/gen-sites.mjs --check && node apps/docs/shared/sync-content.mjs --all --check",
      "docs:deploy": "pnpm --filter \"@smithers/docs-*\" --filter \"!@smithers/docs-shared\" -r run deploy",
      "docs:sync": "node apps/docs/shared/sync-content.mjs --all",
      dev: "pnpm --filter smithers-app run start",
      lint: "pnpm --recursive --if-present run lint",
      "lint:jsdoc":
        "eslint --config eslint.config.js \"packages/*/src/**/*.ts\" \"packages/*/*/src/**/*.ts\" \"packages/*/*/*/src/**/*.ts\" --max-warnings=0",
      "release:answer": "node --experimental-strip-types flows/release-support/main.ts answer",
      "release:content": "node --experimental-strip-types flows/release-support/main.ts release-content",
      "release:status": "node --experimental-strip-types flows/release-support/main.ts status",
      "release:workflow": "node --experimental-strip-types flows/release-support/main.ts release",
      test: "pnpm --recursive --if-present run test",
      "test:e2e": "bun apps/app/e2e/packaged/run.ts",
      "test:examples": "pnpm --filter @smthrs/examples run test",
      "test:jsdoc": "node --test eslint.jsdoc.test.mjs"
    })
    const targets = readFileSync(join(packagesDir, "..", "PACKAGE.ts"), "utf8")
    const jsdocTree = targets.match(/const jsdocTree = Smithers\.EsLint\(\{([\s\S]*?)\n\}\)/)?.[1]
    assert.notEqual(jsdocTree, undefined)
    const targetGlobs = Array.from(jsdocTree!.matchAll(/Smithers\.glob\("([^"]+)"\)/g), (match) => match[1])
    const scriptGlobs = Array.from(root.scripts!["lint:jsdoc"]!.matchAll(/"([^"]+)"/g), (match) => match[1])
    assert.deepEqual(targetGlobs, scriptGlobs)
  })

  it("pins the CI steps that reach the target graph and the jj install (issue #166)", () => {
    // The yml is the last unpinned hop: a step that stops running the package
    // graph (or drops the jj install the real-binary host suite requires, issue
    // #163) skips enforcement with every conformance cell green. Source-text
    // pins, matching the config-source approach used across this suite.
    //
    // The gates used to be `pnpm run check`, `pnpm run lint`, `pnpm run
    // circular`, `pnpm run browser`, and `pnpm test` — five recursive scripts
    // named as raw strings in PACKAGE.ts. They are targets now, so what is pinned
    // is the verb-and-pattern invocation that plans them: `smthrs ci` over the
    // package graph covers lib, check, test, lint, fmt, docs, and circular for
    // every package, and the browser contract is its own labelled target.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    assert.match(ci, /^\s*- uses: pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86$/m)
    assert.match(ci, /^\s*- run: pnpm install --frozen-lockfile --ignore-scripts$/m)
    assert.match(ci, /^\s*run: pnpm exec smthrs ci '\/\/packages\/\.\.\.' --jobs 2 --verbose$/m)
    assert.match(ci, /^\s*run: pnpm exec smthrs test '\/\/scripts\/\.\.\.' --verbose$/m)
    // Browser support is a hard requirement met through layers; the browser
    // contract target is the only thing that proves it, so CI has to run it
    // (REVIEW.md blocker 7).
    assert.match(ci, /^\s*run: pnpm exec smthrs test '\/\/scripts:webBundleContract' --verbose$/m)
    assert.match(ci, /^\s*run: pnpm exec smthrs test '\/\/packages\/\.\.\.' --jobs 2 --verbose$/m)
    // The Bun compatibility matrix. It used to be `//ci/...`, a directory whose
    // only content was one Vitest target per package, declared from outside the
    // package it re-ran, and then a dedicated `bun` job running
    // `//packages/...:bunTest`. Both are gone: a `bunTest` is a `test`-kind
    // target inside its own package, so the two pins above --
    // `ci '//packages/...'` and `test '//packages/...'` -- already plan every
    // Bun suite. What has to stay pinned is that those two jobs install Bun,
    // because dropping the runtime from either toolchain would make the suites
    // fail to run rather than silently skip.
    assert.ok(!ci.includes("//ci/..."))
    const bunSetup = ci.split(/^  (?=\S)/m).filter((job) =>
      job.includes("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    )
    assert.ok(bunSetup.length >= 2)
    assert.equal(bunSetup.some((job) => job.startsWith("test:")), true)
    assert.equal(bunSetup.some((job) => job.startsWith("packages:")), true)
    // The fault matrix. Until release gate B6 it ran under no gate at all:
    // `//packages/...` did not reach `e2e/`, `e2e` was not a workspace member,
    // and `//e2e:faults` failed in 262 ms with `Command "vitest" not found`.
    // There is no `e2e/` any more: each case lives in the package it asserts
    // about and `//packages/...:faults` selects every one of them, so the
    // separate typecheck step is gone too — the `ci '//packages/...'` pin above
    // covers it, because each package's `check` reads its own `test/**`.
    // `--jobs 1` is part of the contract rather than a throughput choice: two
    // packages' fault suites cannot share a machine any more than two files
    // inside one of them can. The job is required now that the redaction
    // deliverable landed: case 22's terminal-log half was the one gate red by
    // design, the redacting logger closed it, and the matrix is 67 of 67.
    assert.ok(!ci.includes("//e2e:"))
    assert.match(ci, /^\s*run: pnpm exec smthrs test '\/\/packages\/\.\.\.:faults' --jobs 1 --verbose$/m)
    // And it gates. `continue-on-error: true` is the single line that makes a
    // lane advisory, so a matrix that runs but cannot fail the pipeline is
    // exactly the state this deliverable left behind, and it would read as
    // green from every other pin in this file. Slice the job out by its own
    // key rather than searching the whole document, because two other lanes
    // legitimately carry the line.
    const faultsJob = ci.slice(ci.indexOf("\n  e2e-faults:") + 1).split(/\n {2}(?=\S)/)[0]!
    assert.ok(faultsJob.includes("//packages/...:faults"))
    assert.ok(!faultsJob.includes("continue-on-error"))
    assert.match(ci, /tool: jj-cli@\d+\.\d+\.\d+/)
    assert.match(ci, /^\s*run: jj git init --colocate$/m)
  })

  it("runs the package suites on every platform as one matrix, with the advisory bit as data", () => {
    // The package suites used to be a required ubuntu job plus two
    // copy-pasted advisory jobs, `node-macos` and `node-windows`, free to
    // drift into running different steps. One matrix runs the same step
    // everywhere. What is pinned is the shape that makes a platform's status
    // legible without an `if:` key: the platform list, one `include:` row per
    // platform carrying its own advisory bit, and a `continue-on-error` that
    // reads that bit rather than excusing every row at once.
    //
    // macOS and Windows are advisory ONLY until the matrix proves them green.
    // Promoting one flips its boolean in PACKAGE.ts and moves the `advisory:
    // true` line below; leaving a promoted platform advisory here is the drift
    // this cell exists to force into review.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    assert.ok(ci.includes(`  packages:
    name: "package suites (\${{ matrix.os }})"
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        include:
          - os: ubuntu-latest
            advisory: false
          - os: macos-latest
            advisory: true
          - os: windows-latest
            advisory: true
    runs-on: \${{ matrix.os }}
    timeout-minutes: 60
    continue-on-error: \${{ matrix.advisory }}
`))
    // One rendering of the step, shared by every platform.
    assert.equal(ci.split("run: pnpm exec smthrs test '//packages/...'").length - 1, 1)
    // The lanes the matrix replaced are gone, not renamed alongside it.
    assert.ok(!ci.includes("node-macos"))
    assert.ok(!ci.includes("node-windows"))
    // A red platform must not cancel the platforms still running: the matrix
    // exists to answer which platforms are green.
    assert.match(ci, /^ {6}fail-fast: false$/m)
  })

  it("keeps every CI step a target invocation, never a hand-written command", () => {
    // The rule this pins: a PACKAGE.ts file declares targets, and the argv a
    // target runs is rendered inside its implementation. A `run:` line in the
    // generated workflow that is not a target invocation, an install, or a
    // toolchain step derived from a declaration would mean someone reopened the
    // free-form step surface that `GithubCiGen` deleted.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    const commands = [...ci.matchAll(/^\s*(?:- )?run: (?!\|)(.+)$/gm)].map((match) => match[1]!)
    assert.ok(commands.length > 0)
    const derived = [
      /^pnpm exec smthrs (?:build|test|lint|docs|review|ci) '\/\/[^']*'( --jobs \d+)? --verbose$/,
      /^pnpm install --frozen-lockfile --ignore-scripts$/,
      /^rustup toolchain install$/,
      /^jj git init --colocate$/
    ]
    assert.deepEqual(commands.filter((command) => !derived.some((shape) => shape.test(command))), [])
    // No recursive pnpm script survives as a gate: those are what the target
    // graph replaced.
    assert.doesNotMatch(ci, /^\s*run: pnpm run /m)
    assert.doesNotMatch(ci, /^\s*run: node --test /m)
  })

  it("pins the CI triggers and forbids step conditions on enforcement (issue #176)", () => {
    // The #166 pins cover the run commands but not the two cheapest silent
    // disables: deleting `pull_request:` from the `on:` block (CI stops
    // gating PRs while every run-line regex still matches), or adding an
    // `if:` condition to a named step (its separate `run:` line matches
    // verbatim regardless). Pin the trigger block exactly, and assert the
    // enforcement jobs contain no `if:` key. The separate cache publisher
    // is guarded to main pushes and cannot satisfy a required PR gate.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m)
    // Evidence collection must run after a failed gate too. Only these named
    // artifact steps may be unconditional finalizers; enforcement steps still
    // cannot add an `if` that makes the required work disappear.
    const enforcement = ci.replace(
      /^ {6}- name: (?:Collect|Upload) (?:ci-test-tier-evidence|apps-e2e-artifacts)\n {8}if: always\(\)$/gm,
      ""
    )
    for (const job of enforcement.split("\njobs:\n")[1]!.split(/\n(?= {2}\S)/)) {
      const checked = job.startsWith("  cache-publish:")
        ? job.replace(/^ {4}if: \$\{\{ github.event_name == 'push' && github.ref == 'refs\/heads\/main' \}\}$/m, "")
        : job
      assert.doesNotMatch(checked, /^\s*if:/m)
    }
  })
})
