// Stays .ts: smthrs discovers targets only in files named PACKAGE.ts.
/**
 * Targets for vibelang.smithers.sh (wiki/decisions/0008-testing.md): the
 * typecheck, the Vitest suites, the Worker suites in local workerd, and the
 * state machine's proofs.
 *
 * Each runs the package script a person runs from `apps/vibelang`, so a
 * target and `pnpm <script>` cannot disagree. `verify` installs LemmaScript
 * and Dafny into the ignored `verify/.tools` on its first run;
 * `verifyBroken` checks every mutation it generates fails its proof, which runs in the normal CI tier.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { Package as flowPackage } from "../../.smithers/flows/PACKAGE.ts"
import { Package as lemmaPackage } from "../../packages/lemmascript/PACKAGE.ts"

/** Everything the app's scripts read: sources, tests, proofs and their configuration. */
const sources = [
  Smithers.glob("//apps/vibelang/src/**/*"),
  Smithers.glob("//apps/vibelang/public/**/*"),
  Smithers.glob("//apps/vibelang/worker/**/*"),
  Smithers.glob("//apps/vibelang/infra/**/*"),
  Smithers.glob("//apps/vibelang/test/**/*"),
  Smithers.glob("//apps/vibelang/fuzz/**/*"),
  Smithers.file("//apps/vibelang/fuzz.config.ts"),
  flowPackage.vibelangFuzzSources,
  Smithers.glob("//apps/vibelang/bench/*.{vibe,ts,json,md}"),
  Smithers.glob("//apps/vibelang/e2e/**/*"),
  Smithers.glob("//apps/vibelang/skills/**/*"),
  Smithers.glob("//apps/vibelang/scripts/**/*"),
  Smithers.glob("//apps/vibelang/wiki/**/*"),
  Smithers.file("//apps/vibelang/package.json"),
  Smithers.file("//patches/@vitest__coverage-v8@5.0.0.patch"),
  Smithers.file("//apps/vibelang/tsconfig.json"),
  Smithers.file("//apps/vibelang/tsconfig.surfaces.json"),
  Smithers.file("//apps/vibelang/tsconfig.scripts.json"),
  Smithers.file("//apps/vibelang/tsconfig.script-tests.json"),
  Smithers.file("//apps/vibelang/playwright.config.ts"),
  Smithers.file("//apps/vibelang/vite.config.ts"),
  Smithers.file("//apps/vibelang/alchemy.run.ts"),
  Smithers.file("//apps/vibelang/index.html")
]

/** The proof harness and the state machine it proves. */
const proofs = [
  Smithers.glob("//apps/vibelang/verify/*.{sh,py,cjs,json}"),
  lemmaPackage.compilerSources,
  Smithers.glob("//apps/vibelang/src/**/*.vibe"),
  Smithers.glob("//apps/vibelang/worker/**/*.vibe"),
  Smithers.glob("//apps/vibelang/scripts/**/*.vibe"),
  Smithers.file("//apps/vibelang/tsconfig.json"),
  // A type-only import reads VibeLang's emitted declaration of its module and everything that imports, including the
  // wiki asset `pnpm wiki:build` generates from the wiki before each proof run (verify/declarations.py).
  Smithers.glob("//apps/vibelang/wiki/**/*"),
  Smithers.file("//apps/vibelang/package.json")
]

/**
 * `pnpm typecheck`: the app, its tests and infrastructure, then the Workers.
 *
 * @since 1.0.0
 * @category test
 */
const typecheck = Smithers.Shell.Test({
  summary: "Typecheck the app, its tests and its Workers with the VibeLang compiler.",
  shell: "cd apps/vibelang && pnpm typecheck",
  data: sources,
  timeout: "10m"
})

/**
 * `pnpm test`: properties, integration, scenes, runtime and agent surfaces, on the mock backend.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.Shell.Test({
  summary: "Run the property, integration, scene, runtime and surface suites on the mock backend.",
  shell: "cd apps/vibelang && pnpm test",
  data: sources,
  timeout: "20m"
})

/** Whole-app source coverage, with the same V8 provider and 100% per-file thresholds as the monorepo. */
const coverage = Smithers.Shell.Test({
  summary: "Measure every .vibe runtime source and fail below 100% lines, branches, functions or statements.",
  shell: "cd apps/vibelang && pnpm test:coverage",
  data: sources,
  timeout: "30m",
  sandbox: { network: "loopback" },
  exclusive: true
})

/** Browser behavior and Chromium source coverage, kept independent from the unit coverage gate. */
const browserCoverage = Smithers.Shell.Test({
  summary: "Run the browser suite and report Chromium execution on the original .vibe sources.",
  shell: "cd apps/vibelang && E2E_4502=4502 pnpm e2e:coverage",
  data: sources,
  timeout: "30m",
  exclusive: true,
  sandbox: { network: "loopback" }
})

/**
 * `pnpm test:workerd`: the API Worker and its Durable Objects in local workerd, with LiveFactory over HTTP.
 *
 * @since 1.0.0
 * @category test
 */
const workerd = Smithers.Shell.Test({
  summary: "Run the API Worker's Durable Objects in local workerd through LiveFactory, the protocol and the CLI.",
  shell: "cd apps/vibelang && pnpm test:workerd",
  data: sources,
  timeout: "20m",
  sandbox: { network: "loopback" }
})

/** The workerd suite's source coverage: Node's V8 report joined with each workerd isolate's counters (0016). */
const workerdCoverage = Smithers.Shell.Test({
  summary: "Measure the workerd suite inside workerd and in Node; fail below 100% lines, branches, functions or statements.",
  shell: "cd apps/vibelang && pnpm test:workerd:coverage",
  data: sources,
  timeout: "30m",
  sandbox: { network: "loopback" },
  exclusive: true
})

/**
 * `pnpm verify`: every marked production contract, proved by Dafny, plus the complete source inventory.
 *
 * @since 1.0.0
 * @category test
 */
const verify = Smithers.Shell.Test({
  summary: "Prove every annotated production decision with LemmaScript and Dafny.",
  shell: "cd apps/vibelang && pnpm verify && node verify/inventory.cjs",
  data: proofs,
  timeout: "30m"
})

/**
 * `pnpm verify:broken`: every generated mutation must fail its proof in its intended function.
 *
 * @since 1.0.0
 * @category test
 */
const verifyBroken = Smithers.Shell.Test({
  summary: "Check that every generated mutation of a production decision fails a proof obligation.",
  shell: "cd apps/vibelang && pnpm verify:broken",
  data: proofs,
  // Preserve per-obligation limits; allow the full expanding suite with the two-worker default.
  timeout: "120m",
})

/** Validated local observations and the 5% deterministic entry-read gate. */
const bench = Smithers.Shell.Test({
  summary: "Benchmark the state machine, protocol, web, surfaces and workerd flows with correctness checks.",
  shell: "cd apps/vibelang && E2E_4503=4503 pnpm bench",
  data: sources,
  timeout: "30m",
  sandbox: { network: "loopback" }
})

/** Strict benchmark-only coverage qualification; an explicit request, separate from timing observations. */
const benchCoverage = Smithers.Shell.Test({
  summary: "Measure benchmark-only source coverage against strict 100% per-file thresholds.",
  shell: "cd apps/vibelang && E2E_4503=4503 pnpm bench:coverage",
  data: sources,
  timeout: "30m",
  sandbox: { network: "loopback" },
  exclusive: true
})

/** Deliberate production measurement; spends real model tokens and is never selected by a wildcard. */
const benchLive = Smithers.Shell.Test({
  summary: "Measure production render, prompt, API and real agent latency; retain raw samples and limitations.",
  shell: "cd apps/vibelang && pnpm bench:live",
  data: sources,
  timeout: "15m",
  sandbox: { network: true },
  exclusive: true
})

/** Schema-derived whole-app targets, real workerd and Chromium, through the durable local flow. */
const fuzz = Smithers.Shell.Test({
  summary: "Fuzz the state machines, protocol, flows, views, surfaces and native Worker routes; replay retained findings.",
  shell: "cd apps/vibelang && pnpm fuzz",
  data: sources,
  timeout: "20m",
  sandbox: { network: true }
})

/** Fuzz-only coverage qualification; includes every source module except the Alchemy declaration (0015). */
const fuzzCoverage = Smithers.Shell.Test({
  summary: "Require independent fuzz-only 100% per-file source coverage; report real gaps without unit-suite credit.",
  shell: "cd apps/vibelang && pnpm fuzz:coverage",
  data: sources,
  timeout: "20m",
  sandbox: { network: true },
  exclusive: true
})

export const Package = Smithers.Package({ targets: { typecheck, test, coverage, browserCoverage, workerd, workerdCoverage, verify, verifyBroken, bench, benchCoverage, benchLive, fuzz, fuzzCoverage } })
