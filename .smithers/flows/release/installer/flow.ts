/**
 * `release/installer`: build, sign, verify or publish the relocatable installer
 * archives from a packed candidate.
 *
 * `pack` installs the candidate's CLI into `output`; `sign` signs an archive set
 * with Cosign; `verify` checks a signed set; `publish` uploads it. Signing and
 * publication read their identity from the environment, never the payload.
 *
 * ```sh
 * smthrs flow start release/installer --data '{"command":"pack","directory":"dist/release-packs","tag":"v1.0.0","output":"dist/installer"}' --wait
 * smthrs flow start release/installer --data '{"command":"verify","directory":"dist/installer","tag":"v1.0.0"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The installer command, its directory and tag, and `pack`'s output directory.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  command: Schema.Literals(["pack", "sign", "verify", "publish"]),
  directory: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
  output: Schema.optionalKey(Schema.NonEmptyString)
}).check(
  Schema.makeFilter((request) =>
    (request.command === "pack") === (request.output !== undefined)
      ? undefined
      : "pack writes into output; the other commands take none"
  )
)

const implementationVersion = "release/installer/v1"

/**
 * Runs `installer-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Installer = Action.make("release/installer/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `installer-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (
  request: typeof Request.Type
): ReadonlyArray<string> => [
  request.command,
  request.directory,
  request.tag,
  ...(request.output === undefined ? [] : [request.output])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Installer.toLayer(
  (request) => runModule(new URL("../installer-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/installer", {
  description: "Build, sign, verify or publish the relocatable installer archives of a packed release candidate.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:npm *",
    "proc:spawn:tar *",
    "proc:spawn:gzip *",
    "proc:spawn:cosign *",
    "proc:spawn:aws *",
    "net:get:github.com/**",
    "net:get:token.actions.githubusercontent.com/**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Installer.call(request))
})
