import { execFileSync } from "node:child_process"
import type { Plugin } from "vite"

// The build the app is (docs/features/bugs.md#the-build): the revision a deploy builds from, which every bug
// report carries and `/version.json` answers, so a report and a deployment name the same commit. `SMITHERS_BUILD`
// names it when set; otherwise the checkout's jj revision, read without snapshotting the working copy: the working
// copy's own commit when it holds changes, marked `+`, else its parents' (a deploy builds from a fresh `jj new` on
// `main`). A machine without jj, or a directory that isn't a checkout, builds `dev`.

/** The longest build name a report keeps. */
export const MAX_BUILD_LENGTH = 64

/** jj's template: the parents' short ids when the working copy is empty, else its own, marked as changed. */
export const REVISION_TEMPLATE = 'if(empty, parents.map(|c| c.commit_id().short(12)).join(","), commit_id.short(12) ++ "+")'

/** Runs `jj` with `args` in `cwd` and answers its output; throws when it can't. */
export type Run = (args: ReadonlyArray<string>, cwd: string) => string

/** jj on this machine, without touching the working copy or prompting. */
export const runJj: Run = (args, cwd) =>
  execFileSync("jj", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })

const NAME = /^[\w.,+-]+$/

/** The build name for `env` in `cwd`: `SMITHERS_BUILD`, else the jj revision, else `dev`. */
export const buildOf = (env: { readonly SMITHERS_BUILD?: string | undefined }, cwd: string, run: Run = runJj): string => {
  const named = env.SMITHERS_BUILD?.trim() ?? ""
  if (named !== "") return NAME.test(named) ? named.slice(0, MAX_BUILD_LENGTH) : "dev"
  try {
    const revision = run(["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", REVISION_TEMPLATE], cwd).trim()
    return revision !== "" && NAME.test(revision) ? revision.slice(0, MAX_BUILD_LENGTH) : "dev"
  } catch {
    return "dev"
  }
}

/** The file beside the app that names its build: `{ "build": "<name>" }`. */
export const VERSION_FILE = "version.json"

/**
 * The Vite plugin: defines `__SMITHERS_BUILD__` as `build` for the app's code (src/main.tsx) and emits
 * `version.json` with it beside the app, which the site serves as a static file.
 */
export const smithersBuild = (build: string): Plugin => ({
  name: "smithers-build",
  config: () => ({ define: { __SMITHERS_BUILD__: JSON.stringify(build) } }),
  generateBundle() {
    this.emitFile({ type: "asset", fileName: VERSION_FILE, source: `${JSON.stringify({ build })}\n` })
  },
})
