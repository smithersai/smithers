/**
 * `init <dir>`: makes `<dir>` an organization wiki root. It copies the public
 * example to `<dir>/Org` when there is none, or validates the one there with
 * the host's own parsers; writes `Org/Setup/.env.example` and
 * `Org/Setup/slack-app-manifest.yaml`; and seeds the state directory's `.env`
 * from the template when it has none. Secrets are never written: every key is
 * left empty for the owner to fill.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  absolute,
  type Command,
  describeFailure,
  exampleRoot,
  type Io,
  loadOrganization,
  nonEmpty,
  stateDirOf,
  workspaceGrants
} from "./settings.ts"
import { environmentExample, modelSeats, slackManifest } from "./templates.ts"

export interface InitOptions {
  readonly dir: string
  readonly stateDir: string
  readonly appName: string
}

export interface InitResult {
  /** `true` when `Org/` was copied from the example, `false` when an existing one was validated. */
  readonly created: boolean
  readonly files: ReadonlyArray<string>
}

export const defaultAppName = "Smithers Org"

/** Replaces `file` whole or not at all. */
const writeAtomic = (file: string, text: string, mode: number) => {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text, { mode })
  renameSync(temporary, file)
}

/**
 * Creates or validates `<dir>/Org` and writes the setup templates. Rejects
 * with the loader's typed error when the organization does not validate; no
 * template is written then.
 */
export const init = async (options: InitOptions): Promise<InitResult> => {
  const org = join(options.dir, "Org")
  const created = !existsSync(org)
  if (created) {
    mkdirSync(options.dir, { recursive: true })
    cpSync(join(exampleRoot, "Org"), org, { recursive: true, errorOnExist: true, force: false })
  }
  const organization = await loadOrganization(options.dir)
  const { loaded } = organization
  const seats = modelSeats(loaded.organization)
  const setup = join(org, "Setup")
  mkdirSync(setup, { recursive: true })
  const environment = environmentExample({
    root: options.dir,
    stateDir: options.stateDir,
    seats,
    repositories: [...workspaceGrants(organization).keys()],
    maxConcurrentVMs: loaded.organization.vm.maxConcurrentVMs
  })
  const files = [join(setup, ".env.example"), join(setup, "slack-app-manifest.yaml")]
  writeAtomic(files[0]!, environment, 0o644)
  writeAtomic(files[1]!, slackManifest(options.appName), 0o644)
  // The state directory holds secrets and run state; only the owner reads it.
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  chmodSync(options.stateDir, 0o700)
  const secrets = join(options.stateDir, ".env")
  if (!existsSync(secrets)) {
    writeAtomic(secrets, environment, 0o600)
    files.push(secrets)
  }
  return { created, files }
}

export const usage = "init <dir> [--state-dir <dir>] [--app-name <name>]"

export const command: Command = {
  name: "init",
  usage,
  run: async (argv: ReadonlyArray<string>, io: Io) => {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { "state-dir": { type: "string" }, "app-name": { type: "string" } }
    })
    if (parsed.positionals.length !== 1) {
      io.err(`usage: ${usage}`)
      return 2
    }
    const dir = absolute(io.cwd, parsed.positionals[0]!)
    const explicit = nonEmpty(parsed.values["state-dir"])
    const stateDir = explicit === undefined ? stateDirOf(io.env) : absolute(io.cwd, explicit)
    try {
      const result = await init({ dir, stateDir, appName: parsed.values["app-name"] ?? defaultAppName })
      io.out(`${result.created ? "created" : "valid"}  ${join(dir, "Org")}`)
      for (const file of result.files) io.out(`wrote  ${file}`)
      io.out(`next   edit ${join(stateDir, ".env")}, then: doctor --root ${dir}`)
      return 0
    } catch (error) {
      io.err(`invalid  ${join(dir, "Org")}`)
      for (const line of describeFailure(error)) io.err(`  ${line}`)
      return 1
    }
  }
}
