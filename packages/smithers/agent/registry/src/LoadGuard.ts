/**
 * The run-time half of a module flow's pin.
 *
 * Discovery measures every module a flow's entry reaches through a specifier
 * it can read. A load whose target is computed (`createRequire(...)`,
 * `import(name)`) names its file only when it runs, so no scan can measure it.
 * Such a flow is admitted only by a host that provides this service, and the
 * service decides each load where it happens, on the file the host's module
 * system actually resolved:
 *
 * - a file inside the flow's source root that is not one of the measured
 *   copies the loader wrote is refused, an original of the measured closure
 *   included, because its live bytes are not the bytes that were measured;
 * - an installed package (a path through a `node_modules` directory) loads as
 *   a static package import does;
 * - every other file, such as the TypeScript, linter or bundler configuration
 *   of the repository a flow works on, loads with the host's authority.
 *
 * The decision reads the file's real path, never the text that named it, so a
 * `..` segment or a symbolic link that leads back inside changes nothing.
 *
 * This is not a sandbox. Source that reads a file and evaluates the text
 * (`eval`, `new Function`, `node:vm`), that installs module hooks of its own,
 * or that starts a worker thread or a child process, which has a module system
 * of its own, is not held; the code that does so is in the measured source an
 * approver reviews.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

/**
 * A run-time load the guard refused. `path` is the real path of the file the
 * load resolved to and `root` the source root that file is held to.
 *
 * The host's module system throws it from the `import()` or `require()` call
 * that asked for the file.
 *
 * @category errors
 * @since 1.0.0
 */
export class UnmeasuredLoadError extends Schema.TaggedError<UnmeasuredLoadError>()(
  "flows/registry/UnmeasuredLoadError",
  {
    path: Schema.String,
    root: Schema.String,
    message: Schema.String
  }
) {}

/**
 * The guard could not hold a closure, so the flow that needs it must not load.
 *
 * @category errors
 * @since 1.0.0
 */
export class LoadGuardError extends Schema.TaggedError<LoadGuardError>()("flows/registry/LoadGuardError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Decides module loads at run time for flows whose loads no scan can read.
 *
 * `protect` holds from then on: the code of a loaded flow can run at any later
 * time. It fails when the guard cannot hold the root, and the flow must then
 * not load. `permit` names one measured copy and lasts for the scope it is
 * called in, which is the load that wrote the copy.
 *
 * @category services
 * @since 1.0.0
 */
export class LoadGuard extends Context.Service<LoadGuard, {
  /** Refuses, from now on, every load of an unpermitted file under the source root `root`. */
  readonly protect: (root: string) => Effect.Effect<void, LoadGuardError>
  /** Lets the measured copy `file` load until the calling scope closes. */
  readonly permit: (file: string) => Effect.Effect<void, LoadGuardError, Scope.Scope>
}>()("flows/registry/LoadGuard") {}
