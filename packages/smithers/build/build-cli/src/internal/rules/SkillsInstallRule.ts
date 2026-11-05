/**
 * Portable host implementation for the durable Skills.Install action.
 * It never replaces or deletes an entry. Exclusive file/link creation and an
 * exact ownership receipt make interrupted installs safe to resume.
 * @since 1.0.0
 */

import { Discovery } from "@smthrs/registry"
import { Effect, FileSystem, Metric, Path, Result } from "effect"

/**
 * The portable declaration an installation action receives.
 *
 * @category models
 * @since 1.0.0
 */
export interface Request {
  readonly library: { readonly root: string }
  readonly agents: ReadonlyArray<"claude" | "codex">
  readonly select?: ReadonlyArray<string> | undefined
}
/**
 * Workspace and home directories supplied by the authenticated host.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly root: string
  readonly home: string
}
/**
 * An installation refusal that never exposes file contents.
 *
 * @category errors
 * @since 1.0.0
 */
export interface InstallError {
  readonly _tag: "SkillsInstallError"
  readonly message: string
}
const refuse = (message: string): InstallError => ({ _tag: "SkillsInstallError", message })
const portableName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Installs only selected, validated skills, refusing foreign links, directories,
 * receipts and destinations outside the host-provided home. Existing owned
 * links remain in place, so every unselected or foreign entry is preserved.
 * All destinations are checked before the first mutation.
 *
 * @category execution
 * @since 1.0.0
 */
export const install = (
  request: Request,
  options: Options
): Effect.Effect<{ readonly installed: ReadonlyArray<string> }, InstallError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const declared = request.library.root
    if (
      typeof declared !== "string" || declared.trim() === "" ||
      /^([/\\]|[A-Za-z]:)/.test(declared) || /[\u0000-\u001f\u007f]/.test(declared) ||
      declared.split(/[/\\]/).some((part) => part === "..")
    ) {
      return yield* Effect.fail(refuse("Skills library root must stay inside the workspace"))
    }
    if (request.agents.length === 0 || request.agents.some((agent) => agent !== "claude" && agent !== "codex")) {
      return yield* Effect.fail(refuse("Skills.Install requires at least one supported agent"))
    }
    const root = yield* fs.realPath(options.root)
    const home = yield* fs.realPath(options.home)
    const library = path.resolve(root, ...declared.trim().split(/[/\\]/))
    const scan = yield* Discovery.make(fs, path).scan({
      source: "project-skills",
      root: library,
      naming: "frontmatter",
      skills: true,
      confinementRoot: root
    }).pipe(Effect.mapError(() => refuse("Skills library could not be read")))
    // Missing flow authority is a conservative registry warning for a valid
    // Agent Skill. It does not invalidate the skill's standard frontmatter.
    const invalid = scan.warnings.find((warning) => warning.code !== "unprojectable_authority")
    if (invalid !== undefined) {
      return yield* Effect.fail(refuse(`Skills library contains refused entries (${invalid.code})`))
    }
    const byName = new Map<string, string>()
    for (const entry of scan.entries) {
      if (!portableName.test(entry.name) || entry.name.length > 64 || byName.has(entry.name)) {
        return yield* Effect.fail(refuse("Skills library names must be unique portable skill names"))
      }
      byName.set(entry.name, path.dirname(entry.path))
    }
    const names = [...new Set(request.select ?? byName.keys())].sort()
    if (names.some((name) => !byName.has(name))) {
      return yield* Effect.fail(refuse("Skills.Install selection contains an unknown skill"))
    }
    const plans: Array<{
      readonly directory: string
      readonly marker: string
      readonly receipt: string
      readonly destination: string
      readonly source: string
      readonly exists: boolean
      readonly hasReceipt: boolean
    }> = []
    // Resolve each existing parent before creating anything; a symlink in the
    // agent directory must not redirect installation outside the named home.
    const insideHome = Effect.fnUntraced(function*(location: string) {
      if (!(yield* fs.exists(location))) return
      const real = yield* fs.realPath(location)
      if (real !== location) return yield* Effect.fail(refuse("Agent skill directory must not be a symbolic link"))
    })
    for (const agent of new Set(request.agents)) {
      const parent = path.join(home, agent === "claude" ? ".claude" : ".agents")
      const directory = path.join(parent, "skills")
      const metadata = path.join(directory, ".smithers-project-skills")
      yield* insideHome(parent)
      yield* insideHome(directory)
      yield* insideHome(metadata)
      const entries = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : []
      const receipts = (yield* fs.exists(metadata)) ? yield* fs.readDirectory(metadata) : []
      for (const name of names) {
        const source = byName.get(name)!
        const destination = path.join(directory, name)
        const marker = path.join(metadata, `${name}.json`)
        const receipt = JSON.stringify({ version: 1, root, library, name, source })
        const hasReceipt = receipts.includes(`${name}.json`)
        if (hasReceipt && (yield* fs.readFileString(marker)) !== receipt) {
          return yield* Effect.fail(refuse(`Refusing foreign skill ownership: ${agent}/${name}`))
        }
        const exists = entries.includes(name)
        if (exists) {
          const link = yield* Effect.result(fs.readLink(destination))
          if (!hasReceipt || Result.isFailure(link) || link.success !== source) {
            return yield* Effect.fail(refuse(`Refusing foreign skill entry: ${agent}/${name}`))
          }
        }
        plans.push({ directory, marker, receipt, destination, source, exists, hasReceipt })
      }
    }
    const synchronize = (location: string) =>
      Effect.scoped(Effect.gen(function*() {
        const file = yield* fs.open(location, { flag: "r" })
        yield* file.sync
      }))
    for (const plan of plans) {
      if (!plan.exists) {
        yield* fs.makeDirectory(path.dirname(plan.marker), { recursive: true })
        if (!plan.hasReceipt) {
          // Publish a complete receipt without replacing an existing marker.
          // A failed write leaves only our scoped temporary file, never a partial
          // ownership claim that would block the next install as foreign.
          yield* Effect.scoped(Effect.gen(function*() {
            const temporary = yield* fs.makeTempFileScoped({
              directory: path.dirname(plan.marker),
              prefix: ".receipt-"
            })
            yield* fs.writeFileString(temporary, plan.receipt)
            yield* synchronize(temporary)
            yield* fs.link(temporary, plan.marker)
          }))
        }
      }
      // Persist the receipt and its parents before publishing a skill link.
      // Existing owned entries also flush: a prior attempt may have stopped
      // after publishing the link but before its directory reached storage.
      yield* synchronize(plan.marker)
      for (const directory of [home, path.dirname(plan.directory), plan.directory, path.dirname(plan.marker)]) {
        yield* synchronize(directory)
      }
      if (!plan.exists) yield* fs.symlink(plan.source, plan.destination)
      yield* synchronize(plan.directory)
    }
    yield* Metric.update(Metric.counter("smithers.skills.installed"), plans.length)
    yield* Effect.logInfo("Project skills installed").pipe(Effect.annotateLogs({ entries: plans.length }))
    return { installed: plans.map((plan) => plan.destination) }
  }).pipe(
    Effect.mapError((cause): InstallError =>
      cause._tag === "SkillsInstallError"
        ? cause
        : refuse("Skills installation failed; existing entries were preserved")
    ),
    Effect.withSpan("Skills.Install")
  )
