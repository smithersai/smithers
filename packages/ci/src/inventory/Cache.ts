/**
 * `actions/cache`, kept on this machine.
 *
 * On GitHub a cache step restores files a past run saved under a key, and
 * saves them again when its job has passed. A repository's CI is as fast as it
 * is because of that: a build tool finds its own cache, a package manager its
 * downloads. A replay that restored nothing would time a slower CI than the
 * one it stands for.
 *
 * So a cache step is two commands here. The first restores, where the step
 * stands. The second saves, after the job's other steps. Both keep their
 * files in a store the step's runner names (`StepFacts.store`): a directory of
 * the replay's own, one for each way of running a commit, outside every
 * checkout and every home, so a job that starts on a new machine still finds
 * what the last one saved.
 *
 * A cache is found as the action finds it: an entry saved under `key` itself,
 * or else the newest entry whose key starts with one of `restore-keys`, taken
 * in the order written. Only entries saved for the same `path` are looked at.
 * An entry is never written twice, so a job that restored its own key saves
 * nothing.
 *
 * The scripts print the lines the action prints, and set its outputs:
 * `cache-hit` is `true` for the key itself, `false` for one of `restore-keys`,
 * and empty when nothing was found. An entry that cannot be unpacked is a
 * warning and a miss, as `@actions/cache` treats a failed restore.
 *
 * @since 0.1.0
 */

import { asScalar, isRecord } from "./Values.ts"

/**
 * The variables the two scripts read. A step's `with:` gives the first five;
 * the restoring script hands the other one, and its own `path` and `key`, to
 * the saving script through its outputs.
 *
 * @category constants
 * @since 0.1.0
 */
export const variables = {
  path: "SMITHERS_CI_CACHE_PATH",
  key: "SMITHERS_CI_CACHE_KEY",
  restoreKeys: "SMITHERS_CI_CACHE_RESTORE_KEYS",
  failOnMiss: "SMITHERS_CI_CACHE_FAIL_ON_MISS",
  lookupOnly: "SMITHERS_CI_CACHE_LOOKUP_ONLY",
  matched: "SMITHERS_CI_CACHE_MATCHED"
} as const

/**
 * The outputs of the restoring script that the saving script is given, each
 * with the variable it becomes. The first two are the action's own outputs;
 * the third is the `path` as the step had it when it started.
 *
 * @category constants
 * @since 0.1.0
 */
export const handedOn: ReadonlyArray<readonly [variable: string, output: string]> = [
  [variables.key, "cache-primary-key"],
  [variables.matched, "cache-matched-key"],
  [variables.path, "smithers-ci-cache-path"]
]

/**
 * The shell the scripts are written for.
 *
 * @category constants
 * @since 0.1.0
 */
export const shell: ReadonlyArray<string> = ["bash", "--noprofile", "--norc", "-eo", "pipefail"]

/**
 * What both scripts start with: where the store is, and how a `path` is
 * read. A cache holds paths from three places, each kept as a path from that
 * place, so it is restored into a checkout, a home or a temporary directory
 * that is somewhere else than the one it was saved from. A pattern, and a
 * path outside those places, is nothing a replay keeps: the step then
 * restores and saves nothing, as after a miss.
 */
const common = [
  `__store=$SMITHERS_CI_CACHE_STORE`,
  `__sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-64; }`,
  `__trim() { __line=\${__line#"\${__line%%[![:space:]]*}"}; __line=\${__line%"\${__line##*[![:space:]]}"}; }`,
  `__work=(); __home=(); __temp=(); __list=`,
  `__sort() {`,
  `  while IFS= read -r __line || [ -n "$__line" ]; do`,
  `    __trim`,
  `    [ -n "$__line" ] || continue`,
  `    case $__line in`,
  `      *[*?[]*|'!'*) echo "smithers-ci: the cache path $__line is a pattern, which a replay does not keep"; return 1;;`,
  `      ..|../*|*/..|*/../*) echo "smithers-ci: the cache path $__line leaves its directory, which a replay does not keep"; return 1;;`,
  `      '~/'?*) __line=\${__line#'~/'}; __home+=("$__line"); __list="$__list"$'\\n'"home:$__line";;`,
  `      "$RUNNER_TEMP"/?*) __line=\${__line#"$RUNNER_TEMP"/}; __temp+=("$__line"); __list="$__list"$'\\n'"temp:$__line";;`,
  `      "$GITHUB_WORKSPACE"/?*) __line=\${__line#"$GITHUB_WORKSPACE"/}; __work+=("$__line"); __list="$__list"$'\\n'"work:$__line";;`,
  `      "$HOME"/?*) __line=\${__line#"$HOME"/}; __home+=("$__line"); __list="$__list"$'\\n'"home:$__line";;`,
  `      /*|'~'*) echo "smithers-ci: the cache path $__line is outside the checkout, the home and the temporary directory"; return 1;;`,
  `      *) __line=\${__line#./}; __work+=("$__line"); __list="$__list"$'\\n'"work:$__line";;`,
  `    esac`,
  `  done`,
  `}`,
  `__key=\${${variables.key}-}`
].join("\n")

/** The lines that read the step's `path` and name the directory of the entries saved for it. */
const sorted = (otherwise: string): string =>
  [
    `if ! __sort <<< "\${${variables.path}-}"; then ${otherwise}; fi`,
    `[ -n "$__list" ] || { echo "Input required and not supplied: path" >&2; exit 1; }`,
    `__saved=$__store/$(printf %s "$__list" | __sum)`
  ].join("\n")

/**
 * The script that restores a cache: `actions/cache` when its step starts,
 * and `actions/cache/restore`.
 *
 * @category constants
 * @since 0.1.0
 */
export const restoreScript = [
  common,
  `[ -n "$__key" ] || { echo "Input required and not supplied: key" >&2; exit 1; }`,
  `case $__key in *,*) echo "Key Validation Error: $__key cannot contain commas." >&2; exit 1;; esac`,
  `[ \${#__key} -le 512 ] || { echo "Key Validation Error: $__key cannot be larger than 512 characters." >&2; exit 1; }`,
  `echo "cache-primary-key=$__key" >> "$GITHUB_OUTPUT"`,
  `printf 'smithers-ci-cache-path<<__SMITHERS_CI_CACHE__\\n%s\\n__SMITHERS_CI_CACHE__\\n' "\${${variables.path}-}" >> "$GITHUB_OUTPUT"`,
  sorted(`echo "Cache not found for input keys: $__key"; exit 0`),
  `__found=; __entry=$__saved/$(printf %s "$__key" | __sum)`,
  `if [ -f "$__entry/key" ]; then`,
  `  __found=$__key`,
  `elif [ -d "$__saved" ]; then`,
  // The newest entry first. An entry's name is its key's checksum, and its `key` file is written last.
  `  while IFS= read -r __line || [ -n "$__line" ]; do`,
  `    __trim`,
  `    [ -n "$__line" ] || continue`,
  `    for __name in $(ls -t "$__saved"); do`,
  `      [ -f "$__saved/$__name/key" ] || continue`,
  `      IFS= read -r __held < "$__saved/$__name/key" || true`,
  `      case $__held in "$__line"*) __found=$__held; __entry=$__saved/$__name; break 2;; esac`,
  `    done`,
  `  done <<< "\${${variables.restoreKeys}-}"`,
  `fi`,
  `__unpack() { [ ! -f "$__entry/$1.tar" ] || tar -xf "$__entry/$1.tar" -C "$2"; }`,
  `if [ -n "$__found" ] && [ "\${${variables.lookupOnly}-}" != true ]; then`,
  `  if ! { __unpack work "$GITHUB_WORKSPACE" && __unpack home "$HOME" && __unpack temp "$RUNNER_TEMP"; }; then`,
  `    echo "::warning::Failed to restore: the cache $__found could not be unpacked"`,
  `    __found=`,
  `  fi`,
  `fi`,
  `if [ -z "$__found" ]; then`,
  `  if [ "\${${variables.failOnMiss}-}" = true ]; then`,
  `    echo "Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: $__key" >&2`,
  `    exit 1`,
  `  fi`,
  `  echo "Cache not found for input keys: $__key"`,
  `  exit 0`,
  `fi`,
  `[ "\${${variables.lookupOnly}-}" != true ] || echo "Lookup only - skipping download"`,
  `echo "cache-matched-key=$__found" >> "$GITHUB_OUTPUT"`,
  `if [ "$__found" = "$__key" ]; then echo "cache-hit=true"; else echo "cache-hit=false"; fi >> "$GITHUB_OUTPUT"`,
  `echo "Cache restored from key: $__found"`
].join("\n")

/**
 * The script that saves a cache: `actions/cache` after its job's other
 * steps, and `actions/cache/save`. An entry is made under a name nobody else
 * can take, filled, and counted as saved only once its key is written.
 *
 * @category constants
 * @since 0.1.0
 */
export const saveScript = [
  common,
  `[ -n "$__key" ] || { echo "smithers-ci: no cache is saved, the step that restores it did not run"; exit 0; }`,
  `if [ "\${${variables.matched}-}" = "$__key" ]; then`,
  `  echo "Cache hit occurred on the primary key $__key, not saving cache."`,
  `  exit 0`,
  `fi`,
  sorted(`echo "smithers-ci: no cache is saved"; exit 0`),
  `__entry=$__saved/$(printf %s "$__key" | __sum)`,
  `mkdir -p "$__saved"`,
  `if ! mkdir "$__entry" 2>/dev/null; then`,
  `  echo "Failed to save: Unable to reserve cache with key $__key, another job may be creating this cache."`,
  `  exit 0`,
  `fi`,
  `trap '[ -f "$__entry/key" ] || rm -rf "$__entry"' EXIT`,
  `__pack() {`,
  `  __name=$1; __from=$2; shift 2; __have=()`,
  `  for __path in "$@"; do`,
  `    if [ -e "$__from/$__path" ] || [ -L "$__from/$__path" ]; then __have+=("./$__path"); fi`,
  `  done`,
  `  [ "\${#__have[@]}" -eq 0 ] || tar -cf "$__entry/$__name.tar" -C "$__from" -- "\${__have[@]}"`,
  `}`,
  `__pack work "$GITHUB_WORKSPACE" \${__work[@]+"\${__work[@]}"}`,
  `__pack home "$HOME" \${__home[@]+"\${__home[@]}"}`,
  `__pack temp "$RUNNER_TEMP" \${__temp[@]+"\${__temp[@]}"}`,
  `if [ -z "$(ls "$__entry")" ]; then`,
  `  echo "Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved."`,
  `  exit 0`,
  `fi`,
  `printf %s "$__key" > "$__entry/key"`,
  `echo "Cache saved with key: $__key"`
].join("\n")

/**
 * What a cache step does, with the variables its script reads as the step's
 * `with:` writes them: text that may hold `${{ }}`.
 *
 * - `cache`: `actions/cache`. It restores where it stands and saves after the job's other steps.
 * - `restore`: `actions/cache/restore`.
 * - `save`: `actions/cache/save`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheUse {
  readonly kind: "cache" | "restore" | "save"
  readonly env: Readonly<Record<string, string>>
}

const kinds: ReadonlyMap<string, CacheUse["kind"]> = new Map([
  ["actions/cache", "cache"],
  ["actions/cache/restore", "restore"],
  ["actions/cache/save", "save"]
])

/**
 * Reads a cache step's `with:`. `undefined` for an action that is no cache
 * action, and for a step that names no `path` or no `key`: the action stops
 * such a step, and a replay runs nothing for it.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const cacheUse = (action: string, inputs: unknown): CacheUse | undefined => {
  const kind = kinds.get(action)
  const given = (name: string): string | undefined => isRecord(inputs) ? asScalar(inputs[name]) : undefined
  const path = given("path")
  const key = given("key")
  if (kind === undefined || path === undefined || key === undefined) return undefined
  const optional: ReadonlyArray<readonly [string, string]> = kind === "save" ? [] : [
    [variables.restoreKeys, "restore-keys"],
    [variables.failOnMiss, "fail-on-cache-miss"],
    [variables.lookupOnly, "lookup-only"]
  ]
  return {
    kind,
    env: {
      [variables.path]: path,
      [variables.key]: key,
      ...Object.fromEntries(optional.flatMap(([name, input]) => {
        const held = given(input)
        return held === undefined ? [] : [[name, held] as const]
      }))
    }
  }
}
