/**
 * Targets for vibelang.smithers.sh (wiki/decisions/0008-testing.md): the
 * typecheck, the Vitest suites and the state machine's proofs.
 *
 * Each runs the package script a person runs from `apps/vibelang`, so a
 * target and `pnpm <script>` cannot disagree. `verify` installs LemmaScript
 * and Dafny into the ignored `verify/.tools` on its first run;
 * `verifyBroken` checks every committed mutation fails its proof, which takes
 * minutes, so it sits in the exclusive tier.
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
  Smithers.file("//apps/vibelang/package.json"),
  Smithers.file("//apps/vibelang/tsconfig.json"),
  Smithers.file("//apps/vibelang/tsconfig.surfaces.json"),
  Smithers.file("//apps/vibelang/vite.config.ts"),
  Smithers.file("//apps/vibelang/alchemy.run.ts"),
  Smithers.file("//apps/vibelang/index.html")
]

/** The proof harness and the state machine it proves. */
const proofs = [
  Smithers.glob("//apps/vibelang/verify/*.{sh,py,cjs,json}"),
  Smithers.glob("//apps/vibelang/verify/broken/**/*"),
  Smithers.file("//apps/vibelang/src/core/conversation.ts")
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
 * `pnpm verify`: LemmaScript's contracts on `src/core/conversation.ts`, proven by Dafny.
 *
 * @since 1.0.0
 * @category test
 */
const verify = Smithers.Shell.Test({
  summary: "Prove the conversation state machine's LemmaScript contracts with Dafny.",
  shell: "cd apps/vibelang && pnpm verify",
  data: proofs,
  timeout: "30m"
})

/**
 * `pnpm verify:broken`: every committed mutation must fail its proof in its intended function.
 *
 * @since 1.0.0
 * @category test
 */
const verifyBroken = Smithers.Shell.Test({
  summary: "Check that every committed mutation of the state machine fails a proof obligation.",
  shell: "cd apps/vibelang && pnpm verify:broken",
  data: proofs,
  timeout: "60m",
  exclusive: true
})

export const Package = Smithers.Package({ targets: { typecheck, test, verify, verifyBroken } })
