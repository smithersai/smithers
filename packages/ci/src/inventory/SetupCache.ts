/**
 * The cache a setup action keeps.
 *
 * `actions/setup-node` with `cache: npm`, `actions/setup-go`, and
 * `actions/setup-python` with `cache: pip` do what a cache step does: when the
 * step starts they restore the package manager's own cache, keyed by the
 * lockfile, and after the job they save it. On GitHub that is why `npm ci`
 * downloads nothing. A job that starts on a new machine with an empty home has
 * to find that cache too, or it is slower than the CI it stands for.
 *
 * So such a step is the two commands of a cache step (`Cache.ts`), with the
 * same store. The path is asked of the tool, as the action asks it:
 * `npm config get cache`, `go env GOMODCACHE`, `pip cache dir`. The key holds
 * the hash of the lockfile, or of the files `cache-dependency-path` names.
 *
 * The hash of the lockfile also decides what the action decides with it: no
 * file, no cache. What is not read gives no cache, which is a miss: the Pipenv and Poetry
 * environments of `setup-python`, Yarn's and pnpm's stores when the action is
 * told a path this cannot follow, and a `setup-go` whose release does not say
 * whether it caches.
 *
 * @since 0.1.0
 */

import { variables } from "./Cache.ts"
import { asScalar, isRecord } from "./Values.ts"

/**
 * What a setup action's cache needs: the shell lines that ask the tool where
 * its cache is, the key as a workflow would write it, and what the action
 * does when no lockfile is found.
 *
 * - `paths`: shell text whose output is the cache's directories, one to a line.
 * - `key`: the key, with `${{ }}` to fill in. `lock` is the part that hashes the lockfile.
 * - `missing`: the action's own words when no lockfile is there, and whether it stops the step.
 *
 * @category models
 * @since 0.1.0
 */
export interface SetupCache {
  readonly paths: string
  readonly key: string
  readonly lock: string
  readonly missing: { readonly said: string; readonly stops: boolean }
}

/**
 * The variable the lockfile's hash is given in, so the step can tell that no
 * lockfile was found.
 *
 * @category constants
 * @since 0.1.0
 */
export const lockVariable = "SMITHERS_CI_CACHE_LOCK"

/** A text as an expression writes it. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/**
 * A pattern as an argument of `hashFiles`. One that holds `${{ }}`, such as a matrix value, is built with `format`:
 * an expression cannot hold another.
 */
const pattern = (text: string): string => {
  const parts = text.split(/\$\{\{(.*?)\}\}/)
  if (parts.length === 1) return literal(text)
  const values = parts.filter((_, index) => index % 2 === 1).map((part) => part.trim())
  const written = parts.map((part, index) =>
    index % 2 === 1 ? `{${(index - 1) / 2}}` : part.replaceAll("{", "{{").replaceAll("}", "}}")
  )
  return `format(${[literal(written.join("")), ...values].join(", ")})`
}

const quoted = (patterns: ReadonlyArray<string>): string => patterns.map(pattern).join(", ")

/** A workflow's text inside the double quotes of a shell `echo`. */
const echoed = (text: string): string => text.replace(/[\\"$`]/g, "\\$&")

/** The patterns `cache-dependency-path` gives, or the action's own when it gives none. */
const lockfiles = (inputs: Record<string, unknown>, own: ReadonlyArray<string>): ReadonlyArray<string> => {
  const given = (asScalar(inputs["cache-dependency-path"]) ?? "").split("\n").map((line) => line.trim())
  const named = given.filter((line) => line !== "")
  return named.length === 0 ? own : named
}

interface Manager {
  readonly paths: string
  readonly own: ReadonlyArray<string>
  readonly found: string
}

/** How `actions/setup-node` asks each package manager for its cache, and the lockfiles it looks for. */
const node: Readonly<Record<string, Manager>> = {
  npm: {
    paths: "npm config get cache",
    own: ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"],
    found: "package-lock.json,npm-shrinkwrap.json,yarn.lock"
  },
  pnpm: { paths: "pnpm store path --silent", own: ["pnpm-lock.yaml"], found: "pnpm-lock.yaml" },
  yarn: {
    // Yarn 1 has `cache dir`; later Yarns keep the folder in their configuration.
    paths: "case $(yarn --version) in 1.*) yarn cache dir;; *) yarn config get cacheFolder;; esac",
    own: ["yarn.lock"],
    found: "yarn.lock"
  }
}

/**
 * The version a step asks for, as part of a key. An expression stays as written, so each variant of a matrix has a
 * key of its own; any other text loses what a key may not hold.
 */
const versioned = (text: string | undefined): string =>
  text === undefined ? "" : text.includes("${{") ? text : text.replace(/[^\w.-]/g, "_")

/** True for a release of `actions/setup-go` that caches unless told not to: version 4 and later. */
const goCaches = (ref: string | undefined): boolean => /^v(?:[4-9]|\d{2,})(?:\.|$)/.test(ref ?? "")

/** The file `actions/setup-go` hashes unless told another: `go.mod` from version 6.3, `go.sum` before it. */
const goFile = (ref: string | undefined): string =>
  /^v(?:6(?:$|\.(?:[3-9]|\d{2,}))|[7-9]|\d{2,})/.test(ref ?? "") ? "go.mod" : "go.sum"

/**
 * Reads the cache a setup step keeps from its `uses:` and `with:`.
 * `undefined` for a step that keeps none, or none this reads.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const setupCache = (uses: string, inputs: unknown): SetupCache | undefined => {
  const [action, ref] = uses.split("@") as [string, string | undefined]
  const given = isRecord(inputs) ? inputs : {}
  const asked = asScalar(given["cache"])
  const keyed = (name: string, lock: string): Pick<SetupCache, "key" | "lock"> => ({
    key: `${name}-\${{ runner.os }}-\${{ runner.arch }}-\${{ ${lock} }}`,
    lock: `\${{ ${lock} }}`
  })
  if (action === "actions/setup-node") {
    const manager = asked === undefined ? undefined : node[asked]
    if (manager === undefined) return undefined
    return {
      paths: manager.paths,
      ...keyed(`node-cache-${asked}`, `hashFiles(${quoted(lockfiles(given, manager.own))})`),
      missing: {
        said: `Dependencies lock file is not found in $GITHUB_WORKSPACE. Supported file patterns: ${manager.found}`,
        stops: true
      }
    }
  }
  if (action === "actions/setup-go") {
    // "Caching dependency files and build outputs": on by default from version 4; `cache: false` turns it off.
    if (asked === "false" || (asked !== "true" && !goCaches(ref))) return undefined
    const version = versioned(asScalar(given["go-version"]) ?? asScalar(given["go-version-file"]))
    const file = goFile(ref)
    return {
      paths: "go env GOMODCACHE; go env GOCACHE",
      ...keyed(`setup-go-${version}`, `hashFiles(${quoted(lockfiles(given, [file]))})`),
      missing: {
        said:
          `Restore cache failed: Dependencies file is not found in $GITHUB_WORKSPACE. Supported file pattern: ${file}`,
        stops: false
      }
    }
  }
  if (action === "actions/setup-python" && asked === "pip") {
    const version = versioned(asScalar(given["python-version"]) ?? asScalar(given["python-version-file"]))
    // The action hashes these, and `**/pyproject.toml` when they match nothing. One hash of both finds the same files.
    const named = lockfiles(given, ["**/requirements.txt"])
    return {
      paths: "pip cache dir",
      ...keyed(`setup-python-${version}-pip`, `hashFiles(${quoted([...named, "**/pyproject.toml"])})`),
      missing: {
        said: `No file in $GITHUB_WORKSPACE matched to [${
          echoed(named.join(","))
        } or **/pyproject.toml], make sure you have checked out the target repository`,
        stops: true
      }
    }
  }
  return undefined
}

/**
 * The lines that go before the restoring script of `Cache.ts`: they do what
 * the action does when no lockfile was found, say `cache-hit` is `false` until
 * a cache is restored, as these actions do and `actions/cache` does not, and
 * ask the tool for its cache's place. A tool that cannot say gives no cache,
 * which is a miss: a job that never starts it still passes. A key holds no
 * comma, which a version range in a matrix can bring. The key and the
 * lockfile's hash arrive in `Cache.variables.key` and {@link lockVariable}.
 *
 * @category shell
 * @since 0.1.0
 * @throws {never}
 */
export const before = (cache: SetupCache): string =>
  [
    `if [ -z "\${${lockVariable}-}" ]; then`,
    `  echo "${cache.missing.said}" >&2`,
    `  exit ${cache.missing.stops ? 1 : 0}`,
    `fi`,
    `echo "cache-hit=false" >> "$GITHUB_OUTPUT"`,
    `${variables.key}=\${${variables.key}//,/_}`,
    `if ! ${variables.path}=$({ ${cache.paths}; } 2>/dev/null) || [ -z "$${variables.path}" ]; then`,
    `  echo "smithers-ci: nothing is restored, this machine cannot say where the cache is kept"`,
    `  exit 0`,
    `fi`
  ].join("\n")
