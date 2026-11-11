/**
 * A rollout host for an Alchemy stack on Cloudflare Workers.
 *
 * The stack's Workers are the scripts Alchemy tagged `alchemy:stack:<stack>` and
 * `alchemy:stage:<stage>`. A release is what they serve: each script's one
 * version at 100%, and the build `<site>/version.json` names. Publishing runs the
 * stack's own deploy command; restoring points each script back at the version
 * it served before, through the same deployments API `wrangler rollback` uses.
 * Database migrations run forward only: a restore brings the older Workers
 * back over the migrated schema, as a manual rollback did.
 */
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Release, RolloutHost, RolloutReceipt } from "./runtime.ts"

/** Where the stack is, how it deploys, and what proves a release healthy. */
export interface AlchemyDeployment {
  readonly stack: string
  readonly stage: string
  /** The directory the deploy and every check command run in. */
  readonly directory: string
  /** The stack's deploy command, as an argument array. */
  readonly deploy: ReadonlyArray<string>
  /** Checks of a published candidate, by name: each command passes by exiting 0. */
  readonly checks: Readonly<Record<string, ReadonlyArray<string>>>
  /** The origin whose `/version.json` names the build it serves. */
  readonly site: string
  readonly cloudflare: { readonly api: string; readonly account: string; readonly token: string }
  /** The file the newest receipt is kept in, across runs. */
  readonly receipts: string
  /** Commands' environment. */
  readonly env: NodeJS.ProcessEnv
  /** How often, and how many milliseconds apart, `serving` reads before it fails: edges cache briefly. */
  readonly serving?: { readonly attempts: number; readonly delay: number }
}

/** The check every phase runs: the stack serves exactly the release. */
export const SERVING = "serving"

interface Deployment {
  readonly created_on: string
  readonly versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>
}

/** Each script and the version it serves, as `name=version` pairs sorted by name. */
export const formatVersions = (versions: Readonly<Record<string, string>>): string =>
  Object.keys(versions).sort().map((name) => `${name}=${versions[name]}`).join(",")

/** The inverse of {@link formatVersions}. */
export const parseVersions = (text: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    text.split(",").map((pair) => {
      const at = pair.indexOf("=")
      if (at <= 0 || at === pair.length - 1) throw new Error("Malformed release version")
      return [pair.slice(0, at), pair.slice(at + 1)]
    })
  )

/** Runs `argv` in `directory` with the terminal's output; resolves its exit code, 1 when it can't start. */
const exitCode = (argv: ReadonlyArray<string>, directory: string, env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve) => {
    // Output goes to the operator's terminal, never into a receipt: it can carry credentials.
    const child = spawn(argv[0]!, argv.slice(1), { cwd: directory, env, stdio: ["ignore", "inherit", "inherit"] })
    child.on("error", () => resolve(1))
    child.on("close", (code) => resolve(code ?? 1))
  })

/** Adapt an Alchemy stack to the rollout policy in `runtime.ts`. */
export function alchemyHost(deployment: AlchemyDeployment): RolloutHost {
  const { api, account, token } = deployment.cloudflare
  const names = Object.keys(deployment.checks)
  if (names.length === 0 || names.includes(SERVING)) {
    throw new Error(`Alchemy rollout needs checks other than ${SERVING}`)
  }
  const cloudflare = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${api}/accounts/${encodeURIComponent(account)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" }
    })
    if (!response.ok) throw new Error(`Cloudflare answered ${response.status}`)
    return ((await response.json()) as { readonly result: unknown }).result
  }
  const scripts = async (): Promise<ReadonlyArray<string>> => {
    const listed = (await cloudflare("/workers/scripts")) as ReadonlyArray<
      { readonly id: string; readonly tags?: ReadonlyArray<string> | null }
    >
    const owned = listed.filter((script) =>
      script.tags?.includes(`alchemy:stack:${deployment.stack}`) &&
      script.tags.includes(`alchemy:stage:${deployment.stage}`)
    ).map((script) => script.id)
    if (owned.length === 0) throw new Error("The stack has no Workers")
    return owned
  }
  const serving = async (script: string): Promise<string> => {
    const { deployments } = (await cloudflare(`/workers/scripts/${encodeURIComponent(script)}/deployments`)) as {
      readonly deployments: ReadonlyArray<Deployment>
    }
    const newest = [...deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0]
    // A split deployment has no one version to come back to.
    if (newest?.versions.length !== 1 || newest.versions[0]!.percentage !== 100) {
      throw new Error("A Worker serves more than one version")
    }
    return newest.versions[0]!.version_id
  }
  const build = async (): Promise<string> => {
    const response = await fetch(`${deployment.site}/version.json`, { headers: { "cache-control": "no-cache" } })
    if (!response.ok) throw new Error(`version.json answered ${response.status}`)
    const { build } = (await response.json()) as { readonly build?: unknown }
    if (typeof build !== "string" || build === "") throw new Error("version.json names no build")
    return build
  }
  const capture = async (): Promise<Release> => {
    const versions: Record<string, string> = {}
    for (const script of await scripts()) versions[script] = await serving(script)
    return { version: formatVersions(versions), revision: await build() }
  }
  const serves = async (release: Release): Promise<boolean> => {
    if ((await build()) !== release.revision) return false
    // A script the release doesn't name was added after it, and no restore can take it back.
    for (const [script, version] of Object.entries(parseVersions(release.version))) {
      if ((await serving(script)) !== version) return false
    }
    return true
  }
  const { attempts, delay } = deployment.serving ?? { attempts: 12, delay: 5_000 }
  return {
    checks: [SERVING, ...names],
    rollbackChecks: [SERVING, ...names],
    // The baseline and a restored release are only read: a check command may write to production.
    previousChecks: [SERVING],
    lastReceipt: async () => {
      let text: string
      try {
        text = readFileSync(deployment.receipts, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
      return JSON.parse(text) as RolloutReceipt
    },
    record: async (receipt) => {
      mkdirSync(dirname(deployment.receipts), { recursive: true })
      const next = `${deployment.receipts}.next`
      writeFileSync(next, `${JSON.stringify(receipt, null, 2)}\n`)
      renameSync(next, deployment.receipts)
    },
    capture,
    publish: async () => {
      const code = await exitCode(deployment.deploy, deployment.directory, deployment.env)
      if (code !== 0) throw new Error(`The deploy exited ${code}`)
      return capture()
    },
    check: async (name, release) => {
      if (name !== SERVING) {
        return {
          status: await exitCode(deployment.checks[name]!, deployment.directory, deployment.env) === 0
            ? "passed"
            : "failed"
        }
      }
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (await serves(release)) return { status: "passed" }
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delay))
      }
      return { status: "failed" }
    },
    restore: async (release) => {
      for (const [script, version] of Object.entries(parseVersions(release.version))) {
        if ((await serving(script)) === version) continue
        await cloudflare(`/workers/scripts/${encodeURIComponent(script)}/deployments`, {
          method: "POST",
          body: JSON.stringify({
            strategy: "percentage",
            versions: [{ version_id: version, percentage: 100 }],
            annotations: { "workers/message": `rollout restore ${release.revision}` }
          })
        })
      }
    }
  }
}
