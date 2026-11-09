/**
 * `docs-sync`: the retired library docs sites' redirect map and the published
 * package documentation, kept in step with each package's `docs/` folder.
 *
 * `write` regenerates `apps/site/docs-redirect/src/docsRedirectMap.ts` from the docs
 * folders. `check` fails when that module drifted, then packs every published
 * package and fails when a tarball drops its README or `docs/`, says it is not
 * on npm, or links a retired `<slug>.smithers.sh` site. `print` prints the
 * folder and page maps. `pnpm docs:sync` and `pnpm docs:check` start it.
 *
 * ```sh
 * smthrs flow start docs-sync --data '{"mode":"write"}' --wait
 * smthrs flow start docs-sync --data '{"mode":"check"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { ModuleFailed, runModule } from "../automation/run-module.ts"

/**
 * One run of `package-docs.mjs`: `print` (no flag), `--write` or `--check`.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  mode: Schema.Literals(["print", "write", "check"])
})

const implementationVersion = "docs-sync/v1"

/**
 * Runs `package-docs.mjs`, and in `check` mode the tarball check after it.
 *
 * @since 1.0.0
 * @category actions
 */
export const Sync = Action.make("docs-sync/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `package-docs.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.mode === "print" ? [] : [`--${request.mode}`]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Sync.toLayer(
  (request) =>
    Effect.gen(function*() {
      yield* runModule(new URL("./package-docs.mjs", import.meta.url), argv(request))
      if (request.mode === "check") yield* runModule(new URL("./package-docs.test.mjs", import.meta.url), [])
    }),
  { implementationVersion }
)

export default Flow.make("docs-sync", {
  description:
    "Regenerate the retired docs sites' redirect map from the package docs folders, or check it and the published package tarballs.",
  capabilities: [
    "fs:read:**",
    "fs:write:apps/site/docs-redirect/src/docsRedirectMap.ts",
    "proc:spawn:node *",
    "proc:spawn:npm *"
  ],
  effects: {
    reads: ["**"],
    writes: ["apps/site/docs-redirect/src/docsRedirectMap.ts"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Sync.call(request))
})
