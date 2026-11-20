/**
 * Builds `smthrs-observe`, the recorder of what a step reads, for x86_64 and
 * aarch64 Linux: `native/observe.c` to `native/out/linux-x64/smthrs-observe`
 * and `native/out/linux-arm64/smthrs-observe`, static, with no library of the
 * host's.
 *
 * The compiler is `zig cc` at one pinned version, so the two programs are the
 * same on every machine that builds them: zig carries the C library and the
 * linker for both targets, and no cross toolchain is needed. `SMITHERS_ZIG`
 * names the zig to use; otherwise the one on `PATH`. With
 * `SMITHERS_NATIVE=required` a missing zig, or another version, fails the
 * build; otherwise the build says so and goes on, and Smithers build records
 * with strace where the program is missing.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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

export const buildObserve = ({
  root = packageRoot,
  zig = process.env.SMITHERS_ZIG ?? "zig",
  required = process.env.SMITHERS_NATIVE === "required",
  log = (line) => console.log(line)
} = {}) => {
  const version = spawnSync(zig, ["version"], { encoding: "utf8" })
  const found = version.status === 0 ? version.stdout.trim() : undefined
  if (found !== zigVersion) {
    const why = found === undefined
      ? `zig ${zigVersion} is not installed (${zig})`
      : `${zig} is zig ${found}, and smthrs-observe is built with zig ${zigVersion}`
    if (required) throw new Error(`smthrs-observe: ${why}`)
    log(`smthrs-observe not built: ${why}; reads are recorded with strace`)
    return []
  }
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
