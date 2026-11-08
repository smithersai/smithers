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

/** Everything the app's scripts read: sources, tests, proofs and their configuration. */
const sources = [
  Smithers.glob("//apps/vibelang/src/**/*"),
  Smithers.glob("//apps/vibelang/worker/**/*"),
  Smithers.glob("//apps/vibelang/infra/**/*"),
  Smithers.glob("//apps/vibelang/test/**/*"),
  Smithers.glob("//apps/vibelang/e2e/**/*"),
  Smithers.glob("//apps/vibelang/skills/**/*"),
  Smithers.glob("//apps/vibelang/scripts/**/*"),
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
  Smithers.glob("//apps/vibelang/src/**/*.vibe"),
  Smithers.glob("//apps/vibelang/worker/**/*.vibe"),
  Smithers.glob("//apps/vibelang/scripts/**/*.vibe"),
  Smithers.file("//apps/vibelang/tsconfig.json"),
  Smithers.file("//apps/vibelang/wiki/decisions/0018-proofs.md")
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
  timeout: "60m",
})

export const Package = Smithers.Package({ targets: { typecheck, test, workerd, verify, verifyBroken } })
