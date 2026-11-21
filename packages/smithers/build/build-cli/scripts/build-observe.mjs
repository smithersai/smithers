/**
 * Builds `smthrs-observe`, the recorder of what a step reads, for x86_64 and
 * aarch64 Linux: `native/observe.c` to `native/out/linux-x64/smthrs-observe`
 * and `native/out/linux-arm64/smthrs-observe`, static, with no library of the
 * host's.
 *
 * The compiler is `zig cc` at one pinned version, so the two programs are the
 * same on every machine that builds them: zig carries the C library and the
 * linker for both targets, and no cross toolchain is needed. `SMITHERS_ZIG`
 * names the zig to use, and only that one. Otherwise the zig on `PATH` when it
 * is the pinned release, and otherwise zig's own archive of it, fetched once
 * into {@link zigCache} and checked against the sum zig publishes. With
 * `SMITHERS_NATIVE=required` no zig, or another version, fails the build;
 * otherwise the build says so and goes on, and Smithers build records with
 * strace where the program is missing.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The zig release the programs are built with; its release archive is dated 2026-11-02, weeks before it was pinned. */
export const zigVersion = "0.17.1"

/** Each platform the release ships, with zig's target for it. */
export const observeTargets = [
  ["linux-x64", "x86_64-linux-musl"],
  ["linux-arm64", "aarch64-linux-musl"]
]

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * zig's own archive of the pinned release for each machine a build fetches it
 * on, by `${process.platform}-${process.arch}`, with the sha256 zig publishes
 * for it in https://ziglang.org/download/index.json (checked 2026-11-20).
 */
export const zigArchives = {
  "linux-x64": ["zig-x86_64-linux-0.17.1", "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a"],
  "linux-arm64": ["zig-aarch64-linux-0.17.1", "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795"],
  "darwin-x64": ["zig-x86_64-macos-0.17.1", "9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7"],
  "darwin-arm64": ["zig-aarch64-macos-0.17.1", "75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d"]
}

/** Where a fetched zig is kept: `SMITHERS_ZIG_CACHE`, else `smithers/zig` in the user's cache directory. */
export const zigCache = (env = process.env) =>
  env.SMITHERS_ZIG_CACHE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "smithers", "zig")

/** Why `zig` cannot build smthrs-observe, or `undefined` when it is the pinned release. */
export const zigProblem = (zig = process.env.SMITHERS_ZIG ?? "zig") => {
  const version = spawnSync(zig, ["version"], { encoding: "utf8" })
  const found = version.status === 0 ? version.stdout.trim() : undefined
  if (found === zigVersion) return undefined
  return found === undefined
    ? `zig ${zigVersion} is not installed (${zig})`
    : `${zig} is zig ${found}, and smthrs-observe is built with zig ${zigVersion}`
}

/**
 * The zig that builds smthrs-observe, `{ zig }`, or why there is none,
 * `{ problem }`. `named` (`SMITHERS_ZIG`) is the only one tried when given.
 * Otherwise the zig on `PATH` when it is the pinned release, else the one
 * fetched before into `cache`, else zig's archive for `host`, fetched from
 * `downloads` and checked against its sum in `archives`.
 */
export const findZig = ({
  named = process.env.SMITHERS_ZIG,
  onPath = "zig",
  host = `${process.platform}-${process.arch}`,
  cache = zigCache(),
  downloads = process.env.SMITHERS_ZIG_DOWNLOADS ?? "https://ziglang.org/download",
  archives = zigArchives
} = {}) => {
  if (named !== undefined) {
    const problem = zigProblem(named)
    return problem === undefined ? { zig: named } : { problem }
  }
  if (zigProblem(onPath) === undefined) return { zig: onPath }
  const archive = archives[host]
  if (archive === undefined) {
    return { problem: `zig ${zigVersion} is not installed, and a build fetches it only on x86_64 or aarch64 Linux or macOS` }
  }
  const [name, sha256] = archive
  const zig = join(cache, name, "zig")
  if (zigProblem(zig) !== undefined) {
    const url = `${downloads}/${zigVersion}/${name}.tar.xz`
    const fetched = spawnSync(process.execPath, [fetchScript, url, sha256, join(cache, name)], { encoding: "utf8" })
    if (fetched.status !== 0) {
      return { problem: `zig ${zigVersion} is not installed, and fetching it failed: ${(fetched.stderr ?? "").trim()}` }
    }
  }
  const problem = zigProblem(zig)
  return problem === undefined ? { zig } : { problem }
}

const fetchScript = join(dirname(fileURLToPath(import.meta.url)), "fetch-zig.mjs")

/** The file in `native/out` that says why nothing was built there. */
export const notBuilt = "not-built.txt"

export const buildObserve = ({
  root = packageRoot,
  named = process.env.SMITHERS_ZIG,
  required = process.env.SMITHERS_NATIVE === "required",
  log = (line) => console.log(line),
  find = findZig
} = {}) => {
  const found = find({ named })
  if (found.problem !== undefined) {
    if (required) throw new Error(`smthrs-observe: ${found.problem}`)
    log(`smthrs-observe not built: ${found.problem}; reads are recorded with strace`)
    // The target declares `native/out`, and Smithers build counts an empty declared directory as not produced.
    // Where nothing could be built (Windows has no zig archive) the directory holds only why, so the build passes
    // and a run there records with strace.
    mkdirSync(join(root, "native", "out"), { recursive: true })
    writeFileSync(join(root, "native", "out", notBuilt), `smthrs-observe not built: ${found.problem}\n`)
    return []
  }
  rmSync(join(root, "native", "out", notBuilt), { force: true })
  const zig = found.zig
  const source = join(root, "native", "observe.c")
  // zig keeps what it compiles once (musl for each target) in its global cache, and this build's own in a
  // directory removed after it.
  const local = mkdtempSync(join(tmpdir(), "smthrs-observe-"))
  const built = []
  for (const [platform, target] of observeTargets) {
    const directory = join(root, "native", "out", platform)
    mkdirSync(directory, { recursive: true })
    const output = join(directory, "smthrs-observe")
    const writing = `${output}.building`
    const result = spawnSync(
      zig,
      ["cc", "-target", target, "-O2", "-static", "-s", "-Wall", "-Werror", "-o", writing, source],
      { encoding: "utf8", env: { ...process.env, ZIG_LOCAL_CACHE_DIR: local } }
    )
    if (result.status !== 0) {
      rmSync(writing, { force: true })
      rmSync(local, { recursive: true, force: true })
      throw new Error(`smthrs-observe: zig cc -target ${target} failed\n${result.stderr}`)
    }
    renameSync(writing, output)
    built.push(output)
  }
  rmSync(local, { recursive: true, force: true })
  return built
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildObserve()
