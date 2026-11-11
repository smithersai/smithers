/**
 * `@smthrs/std`'s batched file calls on a Linux guest: a snapshot, a commit,
 * and a listing, each one shell script and so one round trip.
 *
 * @since 1.0.0-rc.17
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import type * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type { Session } from "../Sandbox/Session.ts"
import { concat } from "./concat.ts"
import { refusalReason } from "./platformReason.ts"
import { rootedAt } from "./rootedPath.ts"

/**
 * The key `@smthrs/std` reads its batched file calls from. The contract is
 * std's (`Read.Batched`); this package implements it without importing std.
 *
 * @category identifiers
 * @since 1.0.0-rc.17
 */
export const Batched = Symbol.for("@smthrs/std/file-batch")

/**
 * What one path held when the snapshot looked.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Snapshot {
  readonly canonical: string | undefined
  readonly version: string
  readonly info: Result.Result<
    { readonly type: FileSystem.File.Type; readonly size: number },
    PlatformError.PlatformError
  >
  readonly content?: Result.Result<Uint8Array, PlatformError.PlatformError> | undefined
}

/**
 * One change to commit, with the version its snapshot saw.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Change {
  readonly path: string
  readonly content: Uint8Array | null
  readonly version: string
  readonly metadataFrom?: string | undefined
}

/**
 * How far a commit got, and the change that stopped it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Committed {
  readonly applied: number
  readonly stopped?: {
    readonly index: number
    readonly reason: "changed" | PlatformError.PlatformError
  } | undefined
}

/**
 * The three batched calls.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface BatchedFiles {
  readonly snapshot: (
    paths: ReadonlyArray<string>,
    options?: {
      readonly read?: ReadonlyArray<string> | undefined
      readonly maxBytes?: number | undefined
    }
  ) => Effect.Effect<ReadonlyArray<Snapshot>, PlatformError.PlatformError>
  readonly commit: (changes: ReadonlyArray<Change>) => Effect.Effect<Committed>
  readonly list: (
    path: string
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly directory: boolean }>, PlatformError.PlatformError>
}

const types: Readonly<Record<number, FileSystem.File.Type>> = {
  0o100000: "File",
  0o040000: "Directory",
  0o120000: "SymbolicLink",
  0o010000: "FIFO",
  0o020000: "CharacterDevice",
  0o060000: "BlockDevice",
  0o140000: "Socket"
}

/**
 * The file type a raw `stat -c %f` mode names.
 *
 * @category utils
 * @since 1.0.0-rc.17
 */
export const fileType = (mode: number): FileSystem.File.Type => types[mode & 0o170000] ?? "Unknown"

/**
 * A guest refusal. The reserved exits name their reason (9 absent, 10
 * occupied, 11 the wrong kind of entry, 12 unreadable); otherwise a utility's
 * `Permission denied` is `PermissionDenied` and anything else `Unknown`.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const refusal = (method: string, path: string, description: string, code = 1): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: code === 9
      ? "NotFound"
      : code === 10
      ? "AlreadyExists"
      : code === 11
      ? "BadResource"
      : code === 12
      ? "PermissionDenied"
      : refusalReason(description),
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description
  })

/**
 * Runs one script and gathers its output, failing only when the session
 * cannot run it. The streams and the exit are read together, so output larger
 * than a pipe cannot deadlock.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const gather = (session: Session, method: string, path: string, script: string, stdin?: Uint8Array) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(script, { stdin })
    const [stdout, stderr, code] = yield* Effect.all([
      Stream.mkString(Stream.decodeText(process.stdout)),
      Stream.mkString(Stream.decodeText(process.stderr)),
      process.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, code }
  })).pipe(Effect.mapError((error) => refusal(method, path, error.message)))

/**
 * `v PATH` prints a version of what is at PATH, following links: a regular
 * file's device, inode, size, change and modification seconds, and `cksum`;
 * another entry's mode, device and inode; `l` for a dangling link; `a` for
 * nothing. Two equal versions mean the entry did not change between them.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const versionFunction = `v() {
  if [ -f "$1" ]; then printf 'f %s %s' "$(stat -L -c '%d %i %s %Y %Z' -- "$1" 2>/dev/null)" "$(cksum < "$1" 2>/dev/null)"
  elif [ -e "$1" ]; then printf 'e %s' "$(stat -L -c '%f %d %i' -- "$1" 2>/dev/null)"
  elif [ -L "$1" ]; then printf l
  else printf a
  fi
}`

/**
 * `q PATH READ MAX` prints four NUL-terminated fields for PATH: where it
 * resolves (`e` and its real path, `p` and its parent's real path, or `n`);
 * its version; its `stat` (`S` and the raw mode and size, `N` for absent, or
 * `E` and the utility's error, decided as the `stat` override decides); and,
 * when READ is 1 and it is a regular file of at most MAX bytes (MAX -1 is no
 * limit), `B` and its base64 or `R` when it is unreadable, else `-`. The
 * version is printed before the bytes are read, so a write between them
 * makes a later commit refuse rather than overwrite it.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const snapshotFunction = `${versionFunction}
q() {
  if [ -e "$1" ]; then c=e$(readlink -f "$1")
  elif [ -e "$(dirname -- "$1")" ]; then c=p$(readlink -f "$(dirname -- "$1")")
  else c=n
  fi
  n=
  if [ ! -e "$1" ] && [ ! -L "$1" ] && [ -x "$(dirname -- "$1")" ]; then s=N
  elif s=$(stat -L -c '%f %s' -- "$1" 2>&1); then n=\${s#* }; s=S$s
  else s=E$s
  fi
  printf '%s\\0%s\\0%s\\0' "$c" "$(v "$1")" "$s"
  if [ "$2" = 1 ] && [ -n "$n" ] && [ -f "$1" ] && { [ "$3" -lt 0 ] || [ "$n" -le "$3" ]; }; then
    if [ -r "$1" ]; then printf B; base64 < "$1" || exit 1; printf '\\0'; else printf 'R\\0'; fi
  else printf '%s\\0' -
  fi
}`

/**
 * The commit's functions. `x I PATH VERSION` stops the batch, before any
 * change, when PATH's version differs. `w I PATH SIZE FROM` stages write I:
 * it refuses a directory or a dangling link, follows an existing link to its
 * file, creates missing parents, copies SIZE bytes of standard input into a
 * fresh temporary file beside the destination, and gives it the mode and
 * owner of the file it replaces, or of FROM, or the umask's default; it
 * leaves the temporary file in `$t` and the destination in `$d`. `r I PATH`
 * refuses a removal of nothing or of a directory. `k I METHOD [TAG]` reports
 * the change that failed and exits 20; `=I` reports a changed entry. Applied
 * changes print `+`.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const commitFunctions = `${versionFunction}
k() { printf '!%s %s %s\\n' "$1" "$2" "\${3:--}"; exit 20; }
x() { [ "$(v "$2")" = "$3" ] || { printf '=%s\\n' "$1"; exit 20; }; }
w() {
  t=
  if [ -d "$2" ]; then printf '%s: is a directory\\n' "$2" >&2; k "$1" writeFile BadResource; fi
  if [ -e "$2" ]; then d=$(readlink -f "$2") || k "$1" writeFile; f=$d
  elif [ -L "$2" ]; then printf '%s: is a dangling symbolic link\\n' "$2" >&2; k "$1" writeFile
  else d=$2; f=$4; mkdir -p -- "$(dirname -- "$2")" || k "$1" makeDirectory
  fi
  t=$(mktemp "$(dirname -- "$d")/.smithers-XXXXXXXX") || k "$1" writeFile
  head -c "$3" > "$t" && [ "$(wc -c < "$t")" -eq "$3" ] || k "$1" writeFile
  if [ -n "$f" ] && [ -e "$f" ]; then
    o=$(stat -L -c %u:%g -- "$f") && m=$(stat -L -c %a -- "$f") || k "$1" writeFile
    [ "$(stat -c %u:%g -- "$t")" = "$o" ] || chown -- "$o" "$t" || k "$1" chown
  else m=$(printf '%o' $((0666 & ~0$(umask))))
  fi
  chmod -- "$m" "$t" || k "$1" chmod
}
r() {
  if [ ! -e "$2" ] && [ ! -L "$2" ]; then printf '%s: nothing is there\\n' "$2" >&2; k "$1" remove NotFound; fi
  if [ -d "$2" ] && [ ! -L "$2" ]; then printf '%s: is a directory\\n' "$2" >&2; k "$1" remove BadResource; fi
}
trap 'exit 143' TERM
trap 'exit 130' INT`

const quote = CommandLine.quote

/**
 * The snapshot script for already rooted paths.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const snapshotScript = (paths: ReadonlyArray<{ readonly path: string; readonly read: boolean }>, max: number) =>
  [snapshotFunction, ...paths.map(({ path, read }) => `q ${quote(path)} ${read ? 1 : 0} ${max}`)].join("\n")

/**
 * The commit script for already rooted changes: compare every version, check
 * every removal, stage every write, compare again, then apply each change in
 * order. A refused removal therefore creates no parent directory. Temporary
 * files left by a stop are removed on exit.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const commitScript = (
  changes: ReadonlyArray<{
    readonly path: string
    readonly size: number | undefined
    readonly version: string
    readonly metadataFrom: string | undefined
  }>
) => {
  const compare = changes.map(({ path, version }, index) => `x ${index} ${quote(path)} ${quote(version)}`)
  const staged = changes.flatMap(({ size }, index) => size === undefined ? [] : [` "$t${index}"`]).join("")
  return [
    commitFunctions,
    `trap 'for y in "$t"${staged}; do [ -z "$y" ] || rm -f -- "$y"; done' EXIT`,
    ...compare,
    ...changes.flatMap(({ path, size }, index) => size === undefined ? [`r ${index} ${quote(path)}`] : []),
    ...changes.flatMap(({ metadataFrom, path, size }, index) =>
      size === undefined
        ? []
        : [`w ${index} ${quote(path)} ${size} ${quote(metadataFrom ?? "")}; t${index}=$t; d${index}=$d`]
    ),
    ...compare,
    ...changes.map(({ path, size }, index) =>
      size === undefined
        ? `rm -- ${quote(path)} || k ${index} remove; echo +`
        : `mv -f -T -- "$t${index}" "$d${index}" || k ${index} rename; t${index}=; echo +`
    )
  ].join("\n")
}

/**
 * The listing script for an already rooted directory without trailing
 * slashes: every entry NUL-terminated, an empty record, then the entries that
 * are directories once links are followed. Exit 11 is a path that is not a
 * directory and 9 an absent one, decided as the `stat` override decides.
 *
 * @category scripts
 * @since 1.0.0-rc.17
 */
export const listScript = (directory: string) =>
  [
    `d=${quote(directory)}`,
    `if [ -d "$d" ]; then find -H "$d" -mindepth 1 -maxdepth 1 -print0 || exit 1; printf '\\0'; ` +
    `find -L "$d" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null; exit 0`,
    `elif [ -e "$d" ]; then exit 11`,
    `elif [ ! -L "$d" ] && [ -x "$(dirname -- "$d")" ]; then exit 9`,
    `else stat -L -- "$d" >/dev/null; exit 1`,
    `fi`
  ].join("\n")

const nameOf = (path: string): string => path.replace(/\/+$/, "").split("/").pop()!

/**
 * `@smthrs/std`'s batched file calls over `session`, a Linux guest. Paths
 * resolve under the session's workdir, as every session path does. `guest`
 * names the machine kind in refusals, such as `container`.
 *
 * A commit that ends without the script's own report, such as one whose
 * process was killed, stops at the change after the last one the guest
 * confirmed. A session that cannot run the commit at all reports a failure of
 * the first change with nothing applied; if the session failed after the
 * script started, the guest may have applied a prefix it could not report.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const batchedFiles = (session: Session, guest: string): BatchedFiles => {
  const resolve = rootedAt(session.workdir)
  const invalid = (method: string, path: string) => refusal(method, path, `the ${guest} answered with invalid output`)
  const describe = (
    path: string,
    [resolved, version, stat, read]: ReadonlyArray<string>,
    asked: boolean
  ): Snapshot => {
    const canonical = resolved!.startsWith("e") && resolved!.length > 1
      ? resolved!.slice(1)
      : resolved!.startsWith("p") && resolved!.length > 1
      ? `${resolved === "p/" ? "" : resolved!.slice(1)}/${nameOf(path)}`
      : undefined
    const fields = stat!.slice(1).trim().split(" ")
    const mode = Number.parseInt(fields[0]!, 16)
    const size = Number(fields[1])
    const info: Snapshot["info"] = stat === "N"
      ? Result.fail(refusal("stat", path, `\`${path}\`: nothing is there in the ${guest}`, 9))
      : !stat!.startsWith("S")
      ? Result.fail(refusal("stat", path, stat!.slice(1).trim()))
      : fields.length !== 2 || !/^[0-9a-f]+$/i.test(fields[0]!) || !Number.isSafeInteger(size) || size < 0
      ? Result.fail(refusal("stat", path, `${guest} stat returned invalid metadata`))
      : Result.succeed({ type: fileType(mode), size })
    if (!asked) return { canonical, version: version!, info }
    let content: Snapshot["content"]
    if (read!.startsWith("B")) {
      const bytes = Base64.decode(read!.slice(1).replaceAll(/\s/g, ""))
      content = Result.isSuccess(bytes)
        ? Result.succeed(bytes.success)
        : Result.fail(refusal("readFile", path, `the ${guest} returned invalid base64 for ${path}`))
    } else if (read === "R") {
      content = Result.fail(refusal("readFile", path, `\`${path}\`: the ${guest}'s user may not read it`, 12))
    } else if (Result.isFailure(info)) {
      content = Result.fail(info.failure)
    } else if (info.success.type !== "File") {
      content = Result.fail(refusal("readFile", path, `\`${path}\`: it is not a regular file in the ${guest}`, 11))
    }
    return { canonical, version: version!, info, ...content === undefined ? {} : { content } }
  }
  return {
    snapshot: (paths, options) => {
      const read = new Set(options?.read)
      const rooted = paths.map((path) => ({ path: resolve(path), read: read.has(path) }))
      const first = rooted[0]?.path ?? session.workdir
      return Effect.flatMap(
        gather(session, "stat", first, snapshotScript(rooted, options?.maxBytes ?? -1)),
        ({ code, stderr, stdout }) => {
          if (code !== 0) return Effect.fail(refusal("stat", first, stderr.trim()))
          const fields = stdout.split("\0")
          if (fields.length !== rooted.length * 4 + 1 || fields.at(-1) !== "") {
            return Effect.fail(invalid("stat", first))
          }
          return Effect.succeed(
            rooted.map(({ path, read }, index) => describe(path, fields.slice(index * 4, index * 4 + 4), read))
          )
        }
      )
    },
    commit: (changes) => {
      const rooted = changes.map((change) => ({
        path: resolve(change.path),
        size: change.content?.byteLength,
        version: change.version,
        metadataFrom: change.metadataFrom === undefined ? undefined : resolve(change.metadataFrom)
      }))
      const stdin = concat(changes.flatMap(({ content }) => content === null ? [] : [content]))
      return gather(session, "writeFile", rooted[0]?.path ?? session.workdir, commitScript(rooted), stdin).pipe(
        Effect.map(({ code, stderr, stdout }): Committed => {
          const lines = stdout.split("\n").filter((line) => line !== "")
          const applied = lines.filter((line) => line === "+").length
          if (code === 0 || applied === changes.length) return { applied: changes.length }
          const last = lines.at(-1) ?? ""
          if (code === 20 && /^=\d+$/.test(last)) {
            return { applied, stopped: { index: Number(last.slice(1)), reason: "changed" } }
          }
          // A stop the script did not report is the change after the last
          // one it confirmed, as when the transport dies part way.
          const report = code === 20 ? /^!(\d+) (\w+) (\w+|-)$/.exec(last) : null
          const index = report === null ? applied : Number(report[1])
          const description = stderr.trim() === "" ? `the ${guest} exited ${code}` : stderr.trim()
          const reason = report?.[3] === "NotFound" ? 9 : report?.[3] === "BadResource" ? 11 : 1
          return {
            applied,
            stopped: { index, reason: refusal(report?.[2] ?? "writeFile", rooted[index]!.path, description, reason) }
          }
        }),
        Effect.catch((error) => Effect.succeed({ applied: 0, stopped: { index: 0, reason: error } }))
      )
    },
    list: (raw) => {
      const path = resolve(raw)
      const directory = path.replace(/\/+$/, "") || "/"
      const prefix = directory === "/" ? "/" : `${directory}/`
      const strip = (entry: string) => entry.startsWith(prefix) ? entry.slice(prefix.length) : entry
      return Effect.flatMap(
        gather(session, "readDirectory", path, listScript(directory)),
        ({ code, stderr, stdout }) => {
          if (code === 9) {
            return Effect.fail(refusal("readDirectory", path, `\`${path}\`: nothing is there in the ${guest}`, 9))
          }
          if (code === 11) {
            return Effect.fail(
              refusal("readDirectory", path, `\`${path}\`: it is not a directory in the ${guest}`, 11)
            )
          }
          if (code !== 0) return Effect.fail(refusal("readDirectory", path, stderr.trim()))
          const records = stdout.split("\0")
          const split = records.indexOf("")
          if (split === -1) return Effect.fail(invalid("readDirectory", path))
          const directories = new Set(records.slice(split + 1).filter((entry) => entry !== "").map(strip))
          return Effect.succeed(
            records.slice(0, split).map(strip).map((name) => ({ name, directory: directories.has(name) }))
          )
        }
      )
    }
  }
}
